import { createServer } from "node:net";
import { createOpencode, type Config, type OpencodeClient } from "@opencode-ai/sdk";

export type StatusEvent =
  | { kind: "thinking"; text: string }
  | { kind: "tool-pending"; tool: string }
  | { kind: "tool-running"; tool: string; title?: string }
  | { kind: "tool-completed"; tool: string; title: string }
  | { kind: "tool-error"; tool: string; error: string }
  | { kind: "step-finish"; tokens: { input: number; output: number; reasoning: number } }
  | { kind: "file-patch"; files: string[] }
  | { kind: "permission-auto"; permission: string }
  | { kind: "permission-ask"; permission: string }
  | { kind: "permission-error"; permission: string; error: string };

export interface RunAgentOptions {
  prompt: string;
  model?: string;
  cwd: string;
  /** Auto-approve OpenCode permission prompts. Default: true. */
  auto?: boolean;
  stream?: (text: string) => void;
  onStatus?: (event: StatusEvent) => void;
  /** Reuse an already-running OpenCode server. Caller is responsible for stopping it. */
  runtime?: OpencodeRuntime;
}

const ALLOW_PERMISSION = {
  edit: "allow",
  bash: "allow",
  webfetch: "allow",
  doom_loop: "allow",
  external_directory: "allow",
} as const;

export type AgentRunOutcome =
  | { kind: "finished" }
  | { kind: "run-error"; error: string }
  | { kind: "startup-error"; error: string };

export type OpencodeRuntime = Awaited<ReturnType<typeof createOpencode>>;

const SERVER_START_TIMEOUT_MS = 20_000;
const START_ATTEMPTS = 6;
const START_RETRY_BASE_MS = 300;
const START_RETRY_MAX_MS = 3_000;
const SQLITE_RELEASE_MS = 400;

export async function runFreshAgent(options: RunAgentOptions): Promise<AgentRunOutcome> {
  let opencode: OpencodeRuntime | undefined = options.runtime;
  const ownsServer = options.runtime === undefined;
  let controller: AbortController | undefined;

  try {
    const auto = options.auto !== false;
    if (!opencode) {
      opencode = await startOpencodeRuntime({ model: options.model, auto });
    }
    const { client } = opencode;
    const serverUrl = opencode.server.url;

    const sessionId = await createSession(client, options.cwd);
    const parsedModel = options.model ? parseModel(options.model) : undefined;

    controller = new AbortController();
    const { stream } = await withTransientRetries("OpenCode event subscribe", () =>
      client.event.subscribe({ signal: controller!.signal }),
    );

    // Signals used to coordinate the background consumer with the main flow.
    let resolveConnected!: () => void;
    let resolveIdle!: (errorMessage: string | undefined) => void;

    const connectedPromise = new Promise<void>(r => { resolveConnected = r; });
    const idlePromise = new Promise<string | undefined>(r => { resolveIdle = r; });

    // Only stream text from assistant messages, not the user's own prompt echo.
    const assistantMessageIds = new Set<string>();
    // Track per-part character offsets for incremental output (delta may be absent).
    const partOffsets = new Map<string, number>();
    // Parts seen so far — used to insert a newline between distinct parts.
    const seenParts = new Set<string>();
    const handledPermissionIds = new Set<string>();

    const handlePermissionAsk = async (request: PendingPermission): Promise<void> => {
      if (request.sessionID !== sessionId) return;
      if (handledPermissionIds.has(request.id)) return;
      handledPermissionIds.add(request.id);

      if (!auto) {
        options.onStatus?.({ kind: "permission-ask", permission: request.name });
        return;
      }

      options.onStatus?.({ kind: "permission-auto", permission: request.name });
      const error = await replyPermissionAlways({
        client,
        serverUrl,
        sessionId,
        permissionId: request.id,
        cwd: options.cwd,
      });
      if (error) {
        options.onStatus?.({ kind: "permission-error", permission: request.name, error });
      }
    };

    // Start consuming SSE events as a background task. Doing this before
    // calling promptAsync ensures the SSE fetch is already in-flight (and we
    // wait for server.connected below) so we can't miss any events.
    const consumeTask = (async () => {
      for await (const event of stream) {
        const permissionAsk = pendingPermissionFromEvent(event);
        if (permissionAsk) {
          await handlePermissionAsk(permissionAsk);
          continue;
        }

        if (event.type === "server.connected") {
          resolveConnected();
        } else if (event.type === "message.updated") {
          const { info } = event.properties;
          if (info.sessionID === sessionId && info.role === "assistant") {
            assistantMessageIds.add(info.id);
            if (info.error) {
              resolveIdle(formatSessionError(info.error));
            }
          }
        } else if (event.type === "message.part.updated") {
          const { part } = event.properties;
          if (part.sessionID !== sessionId || !assistantMessageIds.has(part.messageID)) {
            continue;
          }

          if (part.type === "text") {
            const prev = partOffsets.get(part.id) ?? 0;
            const newText = part.text.slice(prev);
            if (newText) {
              if (!seenParts.has(part.id)) {
                options.stream?.("\n");
                seenParts.add(part.id);
              }
              options.stream?.(newText);
              partOffsets.set(part.id, part.text.length);
            }
          } else if (part.type === "reasoning") {
            const prev = partOffsets.get(part.id) ?? 0;
            const newText = part.text.slice(prev);
            if (newText) {
              options.onStatus?.({ kind: "thinking", text: newText });
              partOffsets.set(part.id, part.text.length);
            }
          } else if (part.type === "tool") {
            const { state, tool } = part;
            if (state.status === "pending") {
              options.onStatus?.({ kind: "tool-pending", tool });
            } else if (state.status === "running") {
              options.onStatus?.({ kind: "tool-running", tool, title: state.title });
            } else if (state.status === "completed") {
              options.onStatus?.({ kind: "tool-completed", tool, title: state.title });
            } else if (state.status === "error") {
              options.onStatus?.({ kind: "tool-error", tool, error: state.error });
            }
          } else if (part.type === "step-finish") {
            options.onStatus?.({ kind: "step-finish", tokens: part.tokens });
          } else if (part.type === "patch") {
            options.onStatus?.({ kind: "file-patch", files: part.files });
          }
        } else if (event.type === "session.idle") {
          if (event.properties.sessionID === sessionId) {
            resolveIdle(undefined);
            break;
          }
        } else if (event.type === "session.error") {
          if (event.properties.sessionID === sessionId) {
            resolveIdle(formatSessionError(event.properties.error));
            break;
          }
        }
      }
      // If the stream ends without an idle event (e.g. server closed), resolve
      // so callers don't hang.
      resolveIdle(undefined);
    })();

    // Wait until the SSE connection is open before firing the prompt so we
    // don't miss any events that arrive early in the session.
    await Promise.race([
      connectedPromise,
      new Promise<void>(r => setTimeout(r, 3000)), // fallback if server.connected is missing
    ]);

    const pollTask = pollPendingPermissions({
      serverUrl,
      cwd: options.cwd,
      signal: controller.signal,
      onAsk: handlePermissionAsk,
    });

    const promptRes = await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        model: parsedModel,
        parts: [{ type: "text", text: options.prompt }],
      },
      query: { directory: options.cwd },
    });

    if (promptRes.error) {
      controller.abort();
      await Promise.allSettled([consumeTask, pollTask]);
      return { kind: "run-error", error: formatApiError(promptRes.error) ?? "Prompt rejected" };
    }

    // Wait for session.idle (or session.error) via the background consumer.
    const errorMessage = await idlePromise;
    controller.abort();
    await Promise.allSettled([consumeTask, pollTask]);

    if (errorMessage) {
      return { kind: "run-error", error: errorMessage };
    }

    // Some providers (e.g. GitHub Copilot) don't emit message.part.updated
    // SSE events, and the SSE stream can close before the session is done.
    // When nothing was streamed, poll session status until actually idle,
    // then fetch messages via REST as a fallback.
    if (seenParts.size === 0 && options.stream) {
      await pollUntilSessionIdle(client, sessionId, options.cwd);

      const msgsRes = await client.session.messages({
        path: { id: sessionId },
        query: { directory: options.cwd },
      });
      const messages = (msgsRes.data ?? []) as Array<{
        info: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }>;
      let firstPart = true;
      for (const msg of messages) {
        if (msg.info.role !== "assistant") continue;
        for (const part of msg.parts ?? []) {
          if (part.type === "text" && part.text) {
            if (firstPart) {
              options.stream("\n");
              firstPart = false;
            }
            options.stream(part.text);
          }
        }
      }
    }

    return { kind: "finished" };
  } catch (error) {
    return {
      kind: "startup-error",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    controller?.abort();
    if (ownsServer) {
      await stopOpencodeRuntime(opencode);
    }
  }
}

export async function startOpencodeRuntime(options: {
  model?: string;
  auto: boolean;
}): Promise<OpencodeRuntime> {
  return withTransientRetries("OpenCode server start", async () => {
    const port = await allocateListenPort();
    const opencode = await createOpencode({
      hostname: "127.0.0.1",
      // SDK and this OpenCode build both treat port 0 as 4096, which races
      // the previous process and any interactive TUI on the default port.
      port,
      timeout: SERVER_START_TIMEOUT_MS,
      config: buildServerConfig(options.model, options.auto),
    });
    try {
      await waitUntilReachable(opencode.server.url);
      return opencode;
    } catch (error) {
      await stopOpencodeRuntime(opencode);
      throw error;
    }
  });
}

export async function stopOpencodeRuntime(runtime: OpencodeRuntime | undefined): Promise<void> {
  if (!runtime) return;
  const url = runtime.server.url;
  runtime.server.close();
  await waitUntilUnreachable(url);
  await delay(SQLITE_RELEASE_MS);
}

export async function listModels(): Promise<string[]> {
  const opencode = await startOpencodeRuntime({ auto: true });
  try {
    const res = await opencode.client.config.providers();
    if (!res.data) return [];

    const ids: string[] = [];
    for (const provider of res.data.providers) {
      for (const modelId of Object.keys(provider.models)) {
        ids.push(`${provider.id}/${modelId}`);
      }
    }
    return ids.sort();
  } finally {
    await stopOpencodeRuntime(opencode);
  }
}

export function isTransientStartupError(error: unknown): boolean {
  const msg = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : String(error);
  if (isTransientStartupMessage(msg)) return true;
  if (error instanceof Error && error.cause !== undefined) {
    return isTransientStartupError(error.cause);
  }
  return false;
}

function buildServerConfig(model: string | undefined, auto: boolean): Config {
  const config: Config = {};
  if (model) config.model = model;
  if (!auto) return config;

  // String "allow" is the OpenCode 1.1+ YOLO form. Agent-level keys cover the
  // case where the built-in `build` agent still defaults external_directory to ask.
  return {
    ...config,
    permission: "allow",
    agent: {
      build: { permission: { ...ALLOW_PERMISSION } },
    },
  } as Config;
}

interface PendingPermission {
  id: string;
  sessionID: string;
  name: string;
}

function pendingPermissionFromEvent(event: { type: string; properties?: unknown }): PendingPermission | undefined {
  if (event.type !== "permission.updated" && event.type !== "permission.asked") {
    return undefined;
  }
  if (!event.properties || typeof event.properties !== "object") return undefined;
  const properties = event.properties as Record<string, unknown>;
  const id = typeof properties["id"] === "string" ? properties["id"] : undefined;
  const sessionID = typeof properties["sessionID"] === "string" ? properties["sessionID"] : undefined;
  const name = typeof properties["permission"] === "string"
    ? properties["permission"]
    : typeof properties["type"] === "string"
      ? properties["type"]
      : "permission";
  if (!id || !sessionID) return undefined;
  return { id, sessionID, name };
}

async function replyPermissionAlways(options: {
  client: OpencodeClient;
  serverUrl: string;
  sessionId: string;
  permissionId: string;
  cwd: string;
}): Promise<string | undefined> {
  const replyUrl = new URL(`/permission/${encodeURIComponent(options.permissionId)}/reply`, options.serverUrl);
  replyUrl.searchParams.set("directory", options.cwd);
  try {
    const res = await fetch(replyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply: "always" }),
    });
    if (res.ok) return undefined;
  } catch {
    // Fall through to the older session-scoped reply endpoint.
  }

  const legacy = await options.client.postSessionIdPermissionsPermissionId({
    path: { id: options.sessionId, permissionID: options.permissionId },
    body: { response: "always" },
    query: { directory: options.cwd },
  });
  if (legacy.error) return formatApiError(legacy.error) ?? "permission reply failed";
  return undefined;
}

async function pollPendingPermissions(options: {
  serverUrl: string;
  cwd: string;
  signal: AbortSignal;
  onAsk: (request: PendingPermission) => Promise<void>;
}): Promise<void> {
  while (!options.signal.aborted) {
    try {
      const url = new URL("/permission", options.serverUrl);
      url.searchParams.set("directory", options.cwd);
      const res = await fetch(url, { signal: options.signal });
      if (res.ok) {
        const payload: unknown = await res.json();
        const items = Array.isArray(payload) ? payload : [];
        for (const item of items) {
          const request = pendingPermissionFromListItem(item);
          if (request) await options.onAsk(request);
        }
      }
    } catch (error) {
      if (options.signal.aborted) return;
      if (error instanceof Error && error.name === "AbortError") return;
    }
    await sleep(500, options.signal);
  }
}

function pendingPermissionFromListItem(item: unknown): PendingPermission | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const id = typeof record["id"] === "string" ? record["id"] : undefined;
  const sessionID = typeof record["sessionID"] === "string" ? record["sessionID"] : undefined;
  const name = typeof record["permission"] === "string"
    ? record["permission"]
    : typeof record["type"] === "string"
      ? record["type"]
      : "permission";
  if (!id || !sessionID) return undefined;
  return { id, sessionID, name };
}

async function createSession(client: OpencodeClient, cwd: string): Promise<string> {
  return withTransientRetries("OpenCode session create", async () => {
    const sessionRes = await client.session.create({
      body: { title: "opencode-loop" },
      query: { directory: cwd },
    });
    if (sessionRes.data) return sessionRes.data.id;
    throw new Error(formatApiError(sessionRes.error) ?? "Failed to create session");
  });
}

async function withTransientRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientStartupError(error) || attempt === START_ATTEMPTS) {
        throw error;
      }
      const waitMs = Math.min(START_RETRY_BASE_MS * 2 ** (attempt - 1), START_RETRY_MAX_MS);
      const msg = error instanceof Error ? error.message : String(error);
      const summary = msg.split("\n")[0]!.slice(0, 120);
      console.error(`${label} failed (${summary}), retrying in ${waitMs}ms (${attempt}/${START_ATTEMPTS})`);
      await delay(waitMs);
    }
  }
  throw lastError;
}

function isTransientStartupMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("fetch failed") ||
    lower.includes("failed to fetch") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("eaddrinuse") ||
    lower.includes("epipe") ||
    lower.includes("socket hang up") ||
    lower.includes("other side closed") ||
    lower.includes("und_err_") ||
    lower.includes("database is locked") ||
    lower.includes("sqlite_busy") ||
    lower.includes("sqlite_locked") ||
    lower.includes("locking protocol") ||
    lower.includes("timeout waiting for server") ||
    /server exited with code/.test(lower) ||
    /port .+ in use/.test(lower)
  );
}

async function waitUntilReachable(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("OpenCode server did not become reachable");
}

async function waitUntilUnreachable(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(250) });
      await delay(100);
    } catch {
      return;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function allocateListenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(err => {
        if (err || port === 0) reject(err ?? new Error("Failed to allocate a listen port"));
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function parseModel(model: string): { providerID: string; modelID: string } | undefined {
  const slash = model.indexOf("/");
  if (slash === -1) return undefined;
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}

function formatApiError(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as Record<string, unknown>;
  if (typeof e["message"] === "string") return e["message"];
  if (e["data"] && typeof e["data"] === "object") {
    const d = e["data"] as Record<string, unknown>;
    if (typeof d["message"] === "string") return d["message"];
  }
  return JSON.stringify(error);
}

async function pollUntilSessionIdle(
  client: Awaited<ReturnType<typeof createOpencode>>["client"],
  sessionId: string,
  cwd: string,
  intervalMs = 500,
  timeoutMs = 300_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seenBusy = false;
  while (Date.now() < deadline) {
    const res = await client.session.status({ query: { directory: cwd } });
    const statusMap = res.data as Record<string, { type: string }> | undefined;
    const status = statusMap?.[sessionId];
    if (status?.type === "busy" || status?.type === "retry") {
      seenBusy = true;
    } else if (seenBusy) {
      // Was busy, now absent from map (= done) or explicitly idle.
      return;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

function formatSessionError(
  error:
    | { name: string; data: Record<string, unknown> }
    | undefined
    | null,
): string {
  if (!error) return "Session error";
  const msg = error.data?.["message"];
  if (typeof msg === "string") return `${error.name}: ${msg}`;
  return error.name;
}
