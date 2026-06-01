import { readFile } from "node:fs/promises";

export interface PickedTask {
  text: string;
  line: number;
  rawLine: string;
}

const uncheckedPattern = /^(\s*(?:[-*+]|\d+[.)])\s+)\[\s\]\s+(.*)$/;

export async function pickFirstUncheckedTask(path: string): Promise<PickedTask | undefined> {
  const content = await readFile(path, "utf8");
  return pickFirstUncheckedTaskFromMarkdown(content);
}

export async function hasUncheckedTasks(path: string): Promise<boolean> {
  return (await pickFirstUncheckedTask(path)) !== undefined;
}

export async function countUncheckedTasks(path: string): Promise<number> {
  const content = await readFile(path, "utf8");
  return countUncheckedTasksFromMarkdown(content);
}

export function pickFirstUncheckedTaskFromMarkdown(content: string): PickedTask | undefined {
  const lines = content.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const match = uncheckedPattern.exec(line);
    if (!match) continue;

    const text = match[2]?.trim();
    if (!text) continue;

    return {
      text,
      line: index + 1,
      rawLine: line,
    };
  }

  return undefined;
}

export function countUncheckedTasksFromMarkdown(content: string): number {
  let count = 0;

  for (const line of content.split(/\r?\n/)) {
    const match = uncheckedPattern.exec(line);
    const text = match?.[2]?.trim();
    if (text) count += 1;
  }

  return count;
}
