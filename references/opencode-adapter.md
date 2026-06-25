# OpenCode Adapter

OpenCode has **primary agents** and **subagents**, configured in `opencode.json` or as Markdown
files. Project agents live in `.opencode/agents/`; global in `~/.config/opencode/agents/`. The
**filename is the agent name** — there is no `name:` field.

Mode C uses those agent files directly. Mode C2 uses the bundled native team plugin instead: copy
`assets/opencode/plugin/adversarial-team.js` and
`assets/opencode/plugin/adversarial-engine.mjs` into `.opencode/plugin/` together, then confirm the
`adversarial_review` tool registers in the OpenCode session.

Copy `assets/opencode/agents/*.md` into one of the agent directories only when using Mode C.

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

## Dispatch pattern (Mode C2 native team plugin)

1. The lead builds the evidence pack and selects roles using `workflow.md`.
2. The lead calls `adversarial_review` with the evidence, role list, and review size.
3. The plugin creates isolated reviewer sessions, injects role prompts, collects schema-valid
   findings, and for Standard/Full runs an independent arbiter by default.
4. The lead renders the report from `findings`, optional `crossExam`, `arbitration`, and `gaps`.

C2 gives structural session isolation between reviewers, but reviewer read-only behavior is still a
soft prompt constraint. It is not a filesystem permission boundary.

When `debug:true` is configured in `.opencode/adversarial-team.json`, the plugin writes prompt
records to `.opencode/adversarial-team-log/`. Use those logs to verify that each reviewer prompt
contains the evidence pack and role instructions, but not other reviewers' findings.

## Reference

- https://opencode.ai/docs/agents/ — current as of 2026-06; verify `mode`, the tools map, and the
  agents directory against the live docs (OpenCode's schema moves).
