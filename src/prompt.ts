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

  // User instructions come first so skill/process guidance is not buried under
  // the loop's scope constraints. Scope rules limit *which* task to finish,
  // not *how* (skills, tools, and other process still apply).
  return `You are running inside opencode-loop.

User instructions:
${rendered}

Selected task:
- Text: ${context.task.text}
- Task file: ${context.taskFile}
- Task line: ${context.task.line}
- Current iteration: ${context.iteration}
- Working directory: ${context.cwd}

Scope (one task only):
- Complete only the selected task above — do not start or check off other unchecked tasks.
- Follow the user instructions above, including any skills or process they require.
- Use available skills and tools as needed to do the work well; scope limits which task, not how you work.
- When the selected task is complete, update only that checkbox from [ ] to [x], then stop.`;
}
