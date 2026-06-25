#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs, MAIN_HELP, type RunCommand } from "./args.js";
import { loadPrompt, renderPrompt } from "./prompt.js";
import { countUncheckedTasks, hasUncheckedTasks, pickFirstUncheckedTask } from "./task-picker.js";
import { listModels, runFreshAgent, type StatusEvent } from "./sdk.js";

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));

  switch (command.name) {
    case "help":
      console.log(MAIN_HELP);
      return;
    case "models":
      await printModels();
      return;
    case "run":
      await run(command);
      return;
  }
}

async function run(command: RunCommand): Promise<void> {
  const cwd = resolve(command.cwd);
  const taskFile = command.pickTasksFrom ? resolve(cwd, command.pickTasksFrom) : undefined;
  const promptTemplate = await loadPrompt(command);
  const initialTaskCount = taskFile ? await countUncheckedTasks(taskFile) : undefined;
  const maxIterations = command.limit ?? initialTaskCount ?? 1;
  const displayedTotal = initialTaskCount === undefined
    ? maxIterations
    : Math.min(initialTaskCount, maxIterations);

  if (taskFile && initialTaskCount === 0) {
    console.log(`No unchecked tasks found in ${taskFile}.`);
    return;
  }

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const task = taskFile ? await pickFirstUncheckedTask(taskFile) : undefined;

    if (taskFile && !task) {
      console.log(`No unchecked tasks remain in ${taskFile}.`);
      return;
    }

    const renderedPrompt = renderPrompt(promptTemplate, {
      task,
      taskFile,
      iteration,
      cwd,
    });

    console.log(`\nStarting fresh OpenCode agent (${formatIteration(iteration, displayedTotal)})`);
    console.log(`cwd: ${cwd}`);
    if (command.model) {
      console.log(`model: ${command.model}`);
    }
    if (task) {
      console.log(`task: ${task.text} (${taskFile}:${task.line})`);
    }

    thinkingActive = false;

    const outputDir = resolve(cwd, "opencode-loop-output");
    await mkdir(outputDir, { recursive: true });
    const replyFile = resolve(outputDir, `reply-${iteration}.md`);
    let replyBuffer = "";

    const outcome = await runFreshAgent({
      prompt: renderedPrompt,
      model: command.model,
      cwd,
      stream: (text) => {
        process.stdout.write(text);
        replyBuffer += text;
      },
      onStatus: (event) => writeStatus(event),
    });

    endThinking();
    process.stdout.write("\n");
    await writeFile(replyFile, replyBuffer, "utf8");
    console.log(`Reply saved to: ${replyFile}`);

    if (outcome.kind === "startup-error") {
      console.error(`OpenCode startup failed: ${outcome.error}`);
      process.exit(1);
    }

    if (outcome.kind === "run-error") {
      console.error(`OpenCode agent run failed: ${outcome.error}`);
      process.exit(2);
    }

    console.log("OpenCode agent run finished.");

    if (!taskFile) {
      return;
    }

    if (!(await hasUncheckedTasks(taskFile))) {
      console.log(`No unchecked tasks remain in ${taskFile}.`);
      return;
    }
  }
}

function formatIteration(iteration: number, limit: number): string {
  return `task ${iteration}/${limit}`;
}

async function printModels(): Promise<void> {
  const ids = await listModels();

  if (ids.length === 0) {
    console.log("No models found. Make sure you have providers configured in your opencode.json.");
    return;
  }

  for (const id of ids) {
    console.log(id);
  }
}

main().catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});

// ANSI escape helpers for stderr status output.
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;

let thinkingActive = false;

function writeStatus(event: StatusEvent): void {
  switch (event.kind) {
    case "thinking": {
      if (!thinkingActive) {
        thinkingActive = true;
        process.stderr.write(dim("\n[thinking] "));
      }
      process.stderr.write(dim(event.text));
      break;
    }
    case "tool-pending": {
      endThinking();
      process.stderr.write(dim(`\n⏳ ${event.tool}`));
      break;
    }
    case "tool-running": {
      endThinking();
      const label = event.title ? `${event.tool}: ${event.title}` : event.tool;
      process.stderr.write(`\n${cyan("▶")} ${label}`);
      break;
    }
    case "tool-completed": {
      endThinking();
      process.stderr.write(`\n${green("✓")} ${event.tool}: ${event.title}`);
      break;
    }
    case "tool-error": {
      endThinking();
      process.stderr.write(`\n${red("✗")} ${event.tool}: ${event.error}`);
      break;
    }
    case "step-finish": {
      endThinking();
      const { input, output, reasoning } = event.tokens;
      const parts = [`in=${input}`, `out=${output}`];
      if (reasoning > 0) parts.push(`reasoning=${reasoning}`);
      process.stderr.write(dim(`\n[step done: ${parts.join(", ")}]`));
      break;
    }
    case "file-patch": {
      endThinking();
      const fileList = event.files.length <= 3
        ? event.files.join(", ")
        : `${event.files.slice(0, 3).join(", ")} +${event.files.length - 3} more`;
      process.stderr.write(`\n${yellow("⚡")} files changed: ${fileList}`);
      break;
    }
  }
}

function endThinking(): void {
  if (thinkingActive) {
    thinkingActive = false;
    process.stderr.write("\n");
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.trim().length > 0) return error.message;
    return error.name;
  }
  return String(error);
}
