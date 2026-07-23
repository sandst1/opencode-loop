# opencode-loop

Run fresh OpenCode agents from a Node command line app.

`opencode-loop` is for repetitive task lists where each step should get a clean agent context. The durable state lives in your files — usually a prompt file and a markdown task list.

## Requirements

- Node.js 20+
- OpenCode installed and configured (`opencode` on PATH)
- At least one provider configured via `/connect` in OpenCode

No API key environment variable is needed. OpenCode manages provider auth through its own config chain — your `~/.config/opencode/opencode.json`, provider keys from `/connect`, and any project-level `opencode.json` are all picked up automatically.

## Local Setup

Install dependencies and build the local CLI:

```bash
npm install
npm run build
```

Run it directly:

```bash
node dist/index.js --help
```

Optionally link it so `opencode-loop` works from any folder on this machine:

```bash
npm link
opencode-loop --help
```

## Usage

Run a one-shot prompt in the current directory:

```bash
opencode-loop --prompt "Review README.md and fix obvious typos."
```

Choose a model explicitly:

```bash
opencode-loop --model anthropic/claude-sonnet-4-5 --prompt "Review README.md and fix obvious typos."
```

Run from a prompt file:

```bash
opencode-loop --prompt-file prompt.md
```

Pick tasks from a markdown checklist:

```bash
opencode-loop --prompt-file prompt.md --pick-tasks-from docs/task-plan.md
```

Limit how many checkbox tasks to run:

```bash
opencode-loop --prompt-file prompt.md --pick-tasks-from docs/task-plan.md --limit 3
```

List available models (from your configured providers):

```bash
opencode-loop models
```

## Models

Models use the `provider/model` format:

```
anthropic/claude-sonnet-4-5
openai/gpt-4o
google/gemini-2.5-pro
```

Run `opencode-loop models` to see what's available through your configured providers.

If `--model` is omitted, OpenCode uses the `model` field from your `opencode.json` config.

## Config

`opencode-loop` starts an OpenCode server internally per iteration. It automatically loads your full OpenCode config chain:

1. Remote config (`.well-known/opencode`)
2. Global config (`~/.config/opencode/opencode.json`) — your models, providers, and auth
3. `OPENCODE_CONFIG` env var override
4. Project config (`opencode.json` in the working directory)

This means your provider keys, default model, permissions, MCP servers, and other settings all work out of the box.

## Task Files

`--pick-tasks-from` reads the first unchecked markdown checkbox:

```md
- [x] Update installation docs
- [ ] Add a troubleshooting section
- [ ] Verify CLI help output
```

Task selection is deterministic. Each iteration rereads the task file and picks the first unchecked checkbox in file order. Without `--limit`, it keeps selecting the next unchecked task until none remain.

Progress is shown against the number of unchecked tasks found at startup. If the file starts with five unchecked tasks, the runs are shown as `task 1/5`, `task 2/5`, and so on. With `--limit 3`, the total is capped at `3`.

When `--pick-tasks-from` is used, opencode-loop wraps your prompt with single-task scope: your instructions (including skills/process) come first, then the selected checkbox, file, and line. The agent must finish only that checkbox before stopping — scope limits *which* task, not *how* (skills and tools still apply). Assistant output is streamed as the agent works, so progress is visible during each iteration.

The selected task is injected into the prompt template with these variables:

- `{{task}}`
- `{{taskLine}}`
- `{{taskFile}}`
- `{{iteration}}`
- `{{cwd}}`

Example `prompt.md`:

```md
Do exactly this task: {{task}}

Task file: {{taskFile}}
Task line: {{taskLine}}

Update the relevant files and check off the task when complete.
Stop after this task.
```

If `--pick-tasks-from` is used without `--prompt` or `--prompt-file`, `opencode-loop` uses a generic one-task prompt.

## Output

Agent replies are saved to `opencode-loop-output/reply-{N}.md` in the working directory.

## Exit Codes

- `0`: all requested iterations finished successfully, or no unchecked tasks remain.
- `1`: CLI validation, SDK startup, or unexpected error.
- `2`: the OpenCode agent run started but returned an error.
