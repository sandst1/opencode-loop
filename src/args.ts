export type Command = RunCommand | ModelsCommand | HelpCommand;

export interface RunCommand {
  name: "run";
  prompt?: string;
  promptFile?: string;
  pickTasksFrom?: string;
  model?: string;
  limit?: number;
  cwd: string;
}

export interface ModelsCommand {
  name: "models";
}

export interface HelpCommand {
  name: "help";
}

export const MAIN_HELP = `opencode-loop

Run fresh OpenCode agents from a Node CLI.

Usage:
  opencode-loop --prompt "Fix the next task"
  opencode-loop --model anthropic/claude-sonnet-4-5 --prompt "Fix the next task"
  opencode-loop --pick-tasks-from docs/task-plan.md
  opencode-loop --model anthropic/claude-haiku-4-5 --prompt-file prompt.md --pick-tasks-from docs/task-plan.md --limit 3
  opencode-loop models

Commands:
  models    List OpenCode models available via your configured providers

Flags:
  --prompt <text>              Inline prompt text.
  --prompt-file <path>         Read prompt text from a file.
  --pick-tasks-from <path>     Pick the first unchecked markdown checkbox from this file.
  --model <provider/model>     OpenCode model id, e.g. anthropic/claude-sonnet-4-5.
                               Defaults to the model set in your opencode.json config.
  --limit <number>             Maximum task iterations. Without --pick-tasks-from, the prompt runs once.
  --cwd <path>                 Working directory passed to OpenCode. Default: current directory.
  --help                       Show this help.

Prompt template variables:
  {{task}}        Selected checkbox text, or empty without --pick-tasks-from.
  {{taskLine}}    1-based line number for the selected checkbox, or empty.
  {{taskFile}}    Path passed to --pick-tasks-from, or empty.
  {{iteration}}   Current 1-based iteration.
  {{cwd}}         Working directory used for agents.

Model format:
  Models use the provider/model format: anthropic/claude-sonnet-4-5, openai/gpt-4o, etc.
  Run "opencode-loop models" to see models available via your configured providers.
  If --model is omitted, the model from your opencode.json config is used.

If --pick-tasks-from is set without --prompt or --prompt-file, opencode-loop uses a
generic one-task prompt that asks the agent to complete {{task}} and update the
checkbox when done. With --pick-tasks-from and no --limit, opencode-loop keeps
selecting the next unchecked task until none remain. Progress is shown against
the number of unchecked tasks found at startup.`;

export function parseArgs(argv: string[]): Command {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    return { name: "help" };
  }

  if (command === "models") {
    assertNoUnexpectedPositionals(rest, "models");
    return { name: "models" };
  }

  return parseRun(argv);
}

function parseRun(args: string[]): RunCommand | HelpCommand {
  const command: RunCommand = {
    name: "run",
    cwd: process.cwd(),
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;

    switch (arg) {
      case "--help":
      case "-h":
        return { name: "help" };
      case "--prompt":
        command.prompt = readFlagValue(args, ++index, arg);
        break;
      case "--prompt-file":
        command.promptFile = readFlagValue(args, ++index, arg);
        break;
      case "--pick-tasks-from":
        command.pickTasksFrom = readFlagValue(args, ++index, arg);
        break;
      case "--model":
        command.model = readFlagValue(args, ++index, arg);
        break;
      case "--limit": {
        const rawLimit = readFlagValue(args, ++index, arg);
        const parsed = Number.parseInt(rawLimit, 10);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          throw new Error("--limit must be a positive integer");
        }
        command.limit = parsed;
        break;
      }
      case "--cwd":
        command.cwd = readFlagValue(args, ++index, arg);
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (command.prompt && command.promptFile) {
    throw new Error("Use either --prompt or --prompt-file, not both");
  }

  if (!command.prompt && !command.promptFile && !command.pickTasksFrom) {
    throw new Error("Provide --prompt, --prompt-file, or --pick-tasks-from");
  }

  return command;
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function assertNoUnexpectedPositionals(args: string[], command: string): void {
  const helpOnly = args.length === 1 && (args[0] === "--help" || args[0] === "-h");
  if (args.length > 0 && !helpOnly) {
    throw new Error(`Unexpected arguments for ${command}: ${args.join(" ")}`);
  }
}
