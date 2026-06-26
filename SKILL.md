---
name: adversarial-agent-team
description: Use when the user wants an adversarial, red-team, or multi-perspective critique with an arbitrated decision rather than a single-pass review — e.g. "red-team this", "stress-test this design", "debate this decision", "strongest arguments for and against", or any high-stakes or irreversible code, PR, diff, architecture, technical plan, or strategy/risk decision that needs opposing views before committing.
---

# Adversarial Agent Team

## Overview

Run a structured adversarial review: independent **pro** and **con** agents plus
target-specific **dimension reviewers** produce evidence-backed findings, a **cross-examiner**
sharpens the disputes, an **arbiter** decides, and a **scribe** writes one structured report.

**Core principle:** the value is not that many agents speak — it is that conflicting claims become
**comparable, evidence-weighted, and independent**. Independence is only real when each reviewer
reasons *without first reading the others*. That is why Claude Code and OpenCode (isolated context
windows per subagent) are the primary homes for this skill; single-context runtimes are a
documented degraded mode where independence is only partial.

## When to Use

- The user asks to red-team, stress-test, debate, or get "the strongest case for and against".
- A change is high-stakes or irreversible: auth/security code, schema migrations, public API
  contracts, deploy/rollback paths, or a costly business/strategy decision.
- The user wants an arbitrated decision (accept / revise / block) with required changes.

**When NOT to use:** trivial diffs, a quick single-pass "does this look right?", or a one-sided
"just tell me what's wrong" check (that is not adversarial — use a normal review). Spinning up many
agents adds cost and noise.

## Workflow (at a glance)

1. **Coordinator** classifies the target, builds the evidence pack, and picks an execution mode +
   review size.
2. **Pro / Con / dimension reviewers** run independently and emit structured findings.
3. **Cross-examiner** (Full size / high-stakes) compares claims and flags unresolved disputes.
4. **Arbiter** weighs evidence and decides.
5. **Plan Loop** can be used when the user wants the skill to generate a plan: `solution-designer` drafts an `InitialPlan`, the team reviews it, and `plan-synthesizer` produces an `AcceptedPlan` only when arbitration permits it.
6. **Repair Planner** optionally turns required changes into a bounded remediation plan.
7. The remediation plan is optionally reviewed as a one-pass 	arget_type: plan adversarial review.
8. **Scribe** renders the final report.

Load **`references/workflow.md`** for the full process, the four execution modes, dimension
selection, and robustness rules. Follow it — do not invent your own flow.

## Execution Mode (pick first)

| Mode | Runtime | Use for |
| --- | --- | --- |
| A — subagents (default) | Claude Code | Most reviews; genuine independence, lower cost |
| B — agent teams | Claude Code (experimental) | High-stakes live debate; ~3–10× the tokens of A |
| C — subagents | OpenCode | Most reviews on OpenCode |
| C2 — native team plugin | OpenCode | True isolated-session fan-out through the bundled plugin |
| D — single context (degraded) | Codex / plain chat | Fallback only; independence is *partial* |

In **Mode D**, independence is enforced by the orchestrator (it withholds prior outputs) and the
report's overall confidence is capped at `medium` — not by per-role self-checks. See
`references/workflow.md`.

## Review Size (cost control)

- **Minimal** — **Pro + Con + Arbiter**. The irreducible adversarial core. Small / low-stakes.
- **Standard** (default) — Minimal + 2–4 dimensions + Scribe.
- **Full** — Standard + all relevant dimensions + Cross-Examiner. High-stakes / irreversible.

Size by **blast radius and reversibility**, not by diff size. (A one-sided Con-only pass is *not* a
valid size — it has nothing to argue against.)

## Reference Files

- `references/workflow.md` — process, 4 modes, sizing, dimension-selection table, robustness.
- `references/roles.md` — canonical system prompt for every role.
- `references/rubrics.md` — severity / confidence / decision / risk-level and how they map.
- `references/output-schema.md` — the exact YAML each role emits.
- `references/report-template.md` — the single authoritative report layout.
- `references/example.md` — one end-to-end worked review (evidence → findings → decision → report).
- `references/claude-code-adapter.md` — map roles to Claude Code subagents / agent teams.
- `references/opencode-adapter.md` — map roles to OpenCode agents (note the `mode`/tools rules).
- `references/opencode-native-team-plugin-design.md` — Mode C2 plugin design and verified OpenCode
  SDK assumptions.

## Installation

Ready-to-copy agent definitions live under `assets/` (the Claude Code and OpenCode files are *not*
interchangeable — different frontmatter; see the adapters):

- **Claude Code:** copy `assets/claude-code/agents/*.md` into `.claude/agents/`. `tools` is a
  comma-separated list.
- **OpenCode:** copy `assets/opencode/agents/*.md` into `.opencode/agents/`. Each file **must** keep
  `mode: subagent`; `tools` is an enable/disable map, not a list.
- **OpenCode C2 plugin:** copy `assets/opencode/plugin/adversarial-team.js` and
  `assets/opencode/plugin/adversarial-engine.mjs` into `.opencode/plugin/` together. C2 reviewers
  run in isolated sessions; reviewer read-only behavior is a prompt constraint, not a filesystem
  permission boundary.

`cross-examiner.md` ships in both folders but the Coordinator only invokes it at Full size. `solution-designer.md` and `plan-synthesizer.md` are used only for explicit Plan Loop runs. `repair-planner.md` is used only after arbitration when a bounded remediation plan is explicitly requested or required by non-empty `required_changes`.

Then launch: *"Use the adversarial-agent-team protocol on <target>."*

## Pre-use Verification (run once per platform)

These checks pin the version-sensitive assumptions that "copy-ready" depends on:

- **Claude Code:** dispatch the `adversarial-con` subagent on a tiny diff; confirm it returns a
  valid findings YAML block.
- **OpenCode:** install one `mode: subagent` agent; confirm it is hidden from the Tab switcher and
  dispatchable via `@mention`.
- **OpenCode C2 plugin:** confirm the `adversarial_review` and `adversarial_plan_loop` tools register, run a tiny Minimal
  review, and verify it creates separate reviewer sessions plus schema-valid findings. If
  `debug:true` is configured, inspect `.opencode/adversarial-team-log/` and confirm reviewer prompt
  logs contain the evidence pack but not other reviewers' findings.
- **Docs:** confirm the two adapter URLs resolve (agent teams is experimental; paths can move).

## Common Mistakes

- **Forcing consensus.** Preserve real disagreement; the arbiter decides, it does not average.
- **Vague con findings.** Every critique needs evidence or a falsifiable concern, else mark it
  low-confidence `investigate`.
- **Hardcoding code dimensions for a non-code target.** Dimensions are selected by the Coordinator;
  the report's Dimension Reviews section is generated dynamically.
- **Treating Mode D as equivalent.** Disclose partial independence (top-of-report callout) and cap
  overall confidence at `medium`.
