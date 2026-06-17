# Claude Code Adapter

Claude Code offers two runtimes for this skill.

- **Subagents (Mode A, default):** Markdown files with YAML frontmatter; each runs in an isolated
  context and reports back to the caller. Lower cost. Dispatch is not limited to one level — whether
  a subagent may itself dispatch further subagents is configuration-dependent and not required by
  this protocol. The "only the lead can spawn" rule below is a **Mode B** constraint and does **not**
  apply to Mode A.
- **Agent teams (Mode B, high-stakes):** multiple sessions with a shared task list and direct
  messaging; cross-examination becomes a live debate. Higher cost, experimental.

## Subagent files

Copy `assets/claude-code/agents/*.md` into `.claude/agents/` (project) or `~/.claude/agents/`
(user). Frontmatter fields: `name`, `description`, and `tools` (a **comma-separated list**).

```markdown
---
name: adversarial-con
description: Challenge a target — code, plan, or decision — by finding risks, hidden assumptions, edge cases, and reasons to revise or reject. Evidence-backed only.
tools: Read, Grep, Glob
---

You are the con agent in an adversarial review. ...
```

Tool allocation:
- Coordinator: `Read, Grep, Glob, Bash` (gather evidence, incl. `git diff`).
- Pro / Con / dimensions / cross-examiner / arbiter: `Read, Grep, Glob` (read-only).
- Scribe: `Read, Write` (writes the report file).

## Launch pattern (Mode A)

```text
Use the adversarial-agent-team protocol on <target>. Build an evidence pack, then dispatch pro,
con, the relevant dimension reviewers, (optionally) the cross-examiner, the arbiter, and the
scribe. Produce the final report from the report template.
```

## Agent teams (Mode B) — hard constraints

- **Off by default.** Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` in settings/env.
- **Lead-only spawning.** The main session is the lead and the only spawner; **teammates cannot
  spawn teammates** (no nested teams). Map the Coordinator → lead.
- **Frontmatter caveat** (per Claude Code agent-teams docs, 2026-06; experimental — verify against
  current docs). A subagent definition reused as a teammate honors its `tools`/`model`, but its
  `skills` and `mcpServers` frontmatter are **not** applied — teammates load skills/MCP from
  project + user settings instead.
- **Cost.** Each teammate is a full session — roughly **3–10× the tokens of Mode A**. Reserve for
  high-stakes, genuinely parallel review.

Team launch example:

```text
Spawn teammates for an adversarial review of <target>: one pro, one con, a security reviewer, a
correctness reviewer, then a cross-examiner. Have pro and con challenge each other's findings, then
you (lead) arbitrate and write the report.
```

## References

Current as of 2026-06; agent teams is experimental, so paths may move — verify before relying.

- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/agent-teams
