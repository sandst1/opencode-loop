import { readFile } from "node:fs/promises";
import type { PickedTask } from "./task-picker.js";

export interface PromptContext {
  task?: PickedTask;
  taskFile?: string;
  iteration: number;
  cwd: string;
}

const DEFAULT_TASK_PROMPT = `Do exactly this task: {{task}}

Task file: {{taskFile}}
Task line: {{taskLine}}
Working directory: {{cwd}}

Complete only this task. Update the task file checkbox when the task is complete. Stop after this task.`;

export async function loadPrompt(options: { prompt?: string; promptFile?: string; pickTasksFrom?: string }): Promise<string> {
  if (options.prompt !== undefined) return options.prompt;
  if (options.promptFile !== undefined) return readFile(options.promptFile, "utf8");
  if (options.pickTasksFrom !== undefined) return DEFAULT_TASK_PROMPT;
  throw new Error("Provide --prompt, --prompt-file, or --pick-tasks-from");
}

export function renderPrompt(template: string, context: PromptContext): string {
  const replacements: Record<string, string> = {
    task: context.task?.text ?? "",
    taskLine: context.task ? String(context.task.line) : "",
    taskFile: context.taskFile ?? "",
    iteration: String(context.iteration),
    cwd: context.cwd,
  };

  const rendered = template.replace(/\{\{(task|taskLine|taskFile|iteration|cwd)\}\}/g, (_, key: string) => {
    return replacements[key] ?? "";
  });

  if (!context.task || !context.taskFile) return rendered;

  return `You are running inside opencode-loop.

Selected task:
- Text: ${context.task.text}
- Task file: ${context.taskFile}
- Task line: ${context.task.line}
- Current iteration: ${context.iteration}
- Working directory: ${context.cwd}

Strict rules:
- Do exactly the selected task above.
- Do not complete, edit, or check off any other unchecked task in the task file.
- When the selected task is complete, update only that selected checkbox from [ ] to [x].
- Stop after the selected task is complete.

User instructions:
${rendered}`;
}
