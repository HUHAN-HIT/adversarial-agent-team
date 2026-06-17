# OpenCode Adapter

OpenCode has **primary agents** and **subagents**, configured in `opencode.json` or as Markdown
files. Project agents live in `.opencode/agents/`; global in `~/.config/opencode/agents/`. The
**filename is the agent name** — there is no `name:` field.

Copy `assets/opencode/agents/*.md` into one of those directories.

## Two critical differences from Claude Code

1. **`mode` is required for subagents.** Without `mode: subagent`, an agent defaults to `all` and
   behaves as a primary agent — it pollutes the Tab switcher and may not be dispatched as intended.
2. **Tools are an enable/disable map, not a list.** Use
   `tools: { write: false, edit: false, bash: false }` (or `permission:` rules) to make a reviewer
   read-only. There is **no** `tools: Read, Grep, Glob` syntax.

## Subagent file (read-only reviewer)

```markdown
---
description: Challenge a target by finding risks, hidden assumptions, edge cases, and reasons to revise or reject. Evidence-backed only.
mode: subagent
temperature: 0.1
tools:
  write: false
  edit: false
  bash: false
---

You are the con agent in an adversarial review. ...
```

Tool/permission allocation:
- Coordinator: `write: false, edit: false, bash: true` (needs `git diff`).
- Pro / Con / dimensions / cross-examiner / arbiter: `write: false, edit: false, bash: false`.
- Scribe: `write: true, edit: false, bash: false` (writes the report).

For finer control, use `permission:` (e.g. `edit: deny`, `bash: { "*": ask, "git diff": allow }`).

## Dispatch pattern (Mode C)

1. The Coordinator (a primary agent) builds the evidence pack.
2. Subagents produce separate structured findings — dispatched programmatically by the Coordinator
   (a primary agent) via the Task tool; a user can also invoke one manually via `@`-mention, e.g.
   `@adversarial-con review this diff`.
3. The arbiter consumes those findings.
4. The scribe writes the final report.

## Reference

- https://opencode.ai/docs/agents/ — current as of 2026-06; verify `mode`, the tools map, and the
  agents directory against the live docs (OpenCode's schema moves).
