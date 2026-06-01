import { createOpencode } from "@opencode-ai/sdk";

export interface RunAgentOptions {
  prompt: string;
  model?: string;
  cwd: string;
  stream?: (text: string) => void;
}

export type AgentRunOutcome =
  | { kind: "finished" }
  | { kind: "run-error"; error: string }
  | { kind: "startup-error"; error: string };

export async function runFreshAgent(options: RunAgentOptions): Promise<AgentRunOutcome> {
  let opencode: Awaited<ReturnType<typeof createOpencode>> | undefined;

  try {
    opencode = await createOpencode({
      config: options.model ? { model: options.model } : {},
    });
    const { client } = opencode;

    const sessionRes = await client.session.create({
      body: { title: "opencode-loop" },
      query: { directory: options.cwd },
    });

    if (!sessionRes.data) {
      const msg = formatApiError(sessionRes.error) ?? "Failed to create session";
      return { kind: "startup-error", error: msg };
    }

    const sessionId = sessionRes.data.id;
    const parsedModel = options.model ? parseModel(options.model) : undefined;

    const controller = new AbortController();
    const { stream } = await client.event.subscribe({ signal: controller.signal });

    // Signals used to coordinate the background consumer with the main flow.
    let resolveConnected!: () => void;
    let resolveIdle!: (errorMessage: string | undefined) => void;

    const connectedPromise = new Promise<void>(r => { resolveConnected = r; });
    const idlePromise = new Promise<string | undefined>(r => { resolveIdle = r; });

    // Start consuming SSE events as a background task. Doing this before
    // calling promptAsync ensures the SSE fetch is already in-flight (and we
    // wait for server.connected below) so we can't miss any events.
    const consumeTask = (async () => {
      for await (const event of stream) {
        if (event.type === "server.connected") {
          resolveConnected();
        } else if (event.type === "message.part.updated") {
          const { part, delta } = event.properties;
          if (part.sessionID === sessionId && part.type === "text" && delta) {
            options.stream?.(delta);
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
        } else if (event.type === "message.updated") {
          // Surface errors that appear on the assistant message itself.
          const { info } = event.properties;
          if (info.role === "assistant" && info.sessionID === sessionId && info.error) {
            resolveIdle(formatSessionError(info.error));
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
      await consumeTask;
      return { kind: "run-error", error: formatApiError(promptRes.error) ?? "Prompt rejected" };
    }

    // Wait for session.idle (or session.error) via the background consumer.
    const errorMessage = await idlePromise;
    controller.abort();
    await consumeTask;

    if (errorMessage) {
      return { kind: "run-error", error: errorMessage };
    }

    return { kind: "finished" };
  } catch (error) {
    return {
      kind: "startup-error",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    opencode?.server.close();
  }
}

export async function listModels(): Promise<string[]> {
  const opencode = await createOpencode();
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
    opencode.server.close();
  }
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
