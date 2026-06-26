# Workflow

The end-to-end adversarial review process. Follow it exactly so output stays comparable across
runs and platforms.

## 0. Mode and Size Selection (Coordinator does this first)

### Execution modes

- **Mode A — Claude Code subagents (default).** The main session is the Coordinator and dispatches
  each role via the Task tool; each role runs in its own context window and reports back. Genuine
  independence; lower token cost than teams. Dispatch is not restricted to a single level — whether
  a reviewer may itself dispatch further subagents is configuration-dependent and not required by
  this protocol.
- **Mode B — Claude Code agent teams (high-stakes).** Experimental; requires
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`. Roles become teammates that can message each other, so
  cross-examination becomes a live debate. Costs roughly **3–10× the tokens of Mode A**. The lead
  (main session) is the **only** spawner; teammates cannot spawn teammates. Map Coordinator → lead.
  See `claude-code-adapter.md`.
- **Mode C — OpenCode subagents.** The Coordinator (a primary agent) dispatches `mode: subagent`
  reviewers programmatically via the Task tool. Each runs independently. See `opencode-adapter.md`.
- **Mode D — single-context fallback (degraded).** One model role-plays every agent in one context.

### Mode D is degraded — independence is only partial

In one context the model retains everything it has produced, so later roles **cannot be made truly
blind by instruction alone**. Do not pretend otherwise. Controls (none rely on a role policing its
own contamination):

1. **Orchestrator withholding.** When prompting each independent role (Pro, Con, dimensions), the
   Coordinator includes only the evidence pack in that role's prompt — not earlier roles' outputs.
   This reduces, it does not eliminate, anchoring.
2. **Report-level confidence cap.** The Arbiter and Scribe cap the report's **overall** confidence
   at `medium`. This is one structural cap applied at the end, not a per-role self-assessment.
3. **Prominent disclosure.** The report carries a Mode D callout at the top (see
   `report-template.md`).
4. **Prefer escalating out.** If the runtime can open separate sessions or subagents, do that and
   switch to Mode A/C — that is the only way to get real independence.

### Cross-Examiner in Mode D

If Mode D uses a Cross-Examiner: Pro, Con, and dimension reviewers still run blind (evidence pack
only). The **Cross-Examiner is the first role permitted to see all prior outputs** — the blind
phase ends when cross-examination begins. The Arbiter and Scribe also see everything.

### Review sizes (cost control)

- **Minimal** — **Pro + Con + Arbiter**. The irreducible adversarial core (opposition + judgment).
  Small / low-stakes. A Con-only pass is *not* a valid size.
- **Standard** (default) — Minimal + 2–4 selected dimensions + Scribe.
- **Full** — Standard + all relevant dimensions + Cross-Examiner. High-stakes / irreversible.

Size by **blast radius and reversibility**, not target size. A one-line change to auth code is
"Full"; a 400-line change to a throwaway script is "Minimal".

### Dimension selection (Coordinator)

| Target | Default dimensions |
| --- | --- |
| code / pr / diff | correctness, security, test; +architecture if structure changes; +performance on a hot path; +ops if deploy/migration; +ux-api if it touches a public interface |
| architecture | architecture, ops, security; +performance if scaling matters |
| plan / strategy / decision | feasibility, risk, impact, assumption; +implementation if execution-heavy |
| mixed (e.g. a refactor that enables a new product direction) | pull from both pools — e.g. architecture (code) + feasibility (goal) |

## Phase 1 — Intake

Identify: target type, review scope, success criteria, required output format, risk tolerance, and
available evidence.
- **Code evidence:** git diff, relevant files, API contracts, test output, logs, issue/PR text.
- **Goal evidence:** goal statement, constraints, known assumptions, stakeholders, timeline, prior
  decisions.

## Phase 2 — Evidence Pack

Build one compact pack every role sees (schema in `output-schema.md`).

**Size bound:** keep it small enough to sit alongside each role's own reasoning. For large diffs,
**chunk or sample**: include the highest-risk hunks in full, summarize the rest, and record what
was omitted under `known_unknowns` — never drop context silently.

## Phase 3 — Independent Role Review

Run Pro, Con, and the selected dimension reviewers independently (truly parallel in Modes A–C;
withheld-context passes in Mode D). Each emits the findings schema. The Coordinator selects
dimensions (table above); do not run dimensions irrelevant to the target.

## Phase 4 — Cross-Examination (Full size / high-stakes)

The Cross-Examiner compares pro vs con claims, separates evidence-backed from speculative, forces
each side to address the strongest opposing argument, and lists unresolved disputes for the
arbiter. Emits the cross-exam schema. Skipped at Minimal/Standard.

## Phase 5 — Arbitration

The Arbiter weighs evidence, severity, confidence, and reversibility, then decides
`accept | accept_with_conditions | revise | block | investigate` with an overall `risk_level`.

- Judge supplied evidence first; aggregate findings yourself (findings carry no decision value). Any
  genuinely new issue goes under `arbiter_discovered_gaps`.
- Separate blockers from non-blockers; give concrete next actions.
- **Never average opinions.** A single `blocker` can outweigh many approvals.
- In Mode D, set the report's overall confidence no higher than `medium`.

## Phase 6 — Remediation Plan (conditional)

If the Arbiter decides `accept_with_conditions`, `revise`, `block`, or `investigate` and lists
`required_changes`, the lead may explicitly produce a `RemediationPlan` before the final report.
This plan is a separate artifact derived from the arbitration result; it is **not** added to the
arbitration block, and it does not change the original target decision.

The Repair Planner turns `required_changes` into stable `RC1`, `RC2`, ... items and concrete repair
steps with validation, rollback/abort guidance, assumptions, verification commands, and residual
risks. Pure `accept` reviews skip this phase unless the user explicitly asks for a repair plan.

## Phase 7 — Repair Plan Review (conditional, bounded)

When a remediation plan is produced, review that plan as a new `target_type: plan` using the same
adversarial-agent-team protocol. "Agent-team review" means the protocol, not specifically Claude
Mode B; the Coordinator still chooses Mode A/B/C/C2/D based on runtime.

The repair-plan evidence pack must include `review_purpose: repair_plan_review`, `repair_depth: 1`,
`allow_repair_planning: false`, the original required changes, the original arbitration, and the
remediation plan. Default roles are Pro, Con, `implementation-reviewer`, `risk-reviewer`, and
`test-reviewer`; add original high-risk dimensions such as security, architecture, or correctness
when relevant.

This phase is strictly one bounded pass. The repair-plan Arbiter judges whether the plan covers the
original required changes without introducing new problems. It must not generate a repair-plan of a
repair-plan. If the repair-plan decision is `revise`, `block`, or `investigate`, the lead reports
that result; another remediation plan requires an explicit new call.

## Phase 8 — Final Report

The Scribe renders `report-template.md` with dynamic dimension reviews and any supplied
`repairPlan` / `repairPlanReview`. Preserve real disagreement; do not collapse it into false
consensus. The Scribe must not invent a remediation plan when none was produced.

## Robustness (all modes)

- **Invalid YAML from a role:** reject and re-prompt once. If still unparseable, capture the output
  as `schema_violation`. In runtimes that support isolated sessions, the Coordinator may redispatch
  that same role once in a fresh session.
- **Empty, runaway, timeout, or transient agent error:** redispatch the affected role or phase in a
  fresh isolated session when the runtime supports it. Redispatch is bounded (`maxRedispatchPerRole`
  defaults to `1`) and audited under `run_status.redispatch_attempts`.
- **Non-recoverable errors:** do not redispatch unknown roles, missing required inputs, invalid
  repair-plan depth, or `allow_repair_planning:false` recursion guards. Record the gap and mark the
  run failed or incomplete.
- **Critical phase incomplete:** if no reviewer findings are produced, or a required arbiter phase
  does not complete, the report must show `run_status.status: failed|incomplete` and
  `safe_to_use_decision:false`. Do not present a final decision as trustworthy.
- **Mode B teammate stalls:** the lead reassigns or proceeds, noting the gap.
- **Crash / user-abandoned runs:** without a persisted run ledger, the protocol cannot resume from
  the exact interruption point. Start a new review, or use a runtime-specific ledger if available.
  Never convert an abandoned run into a completed report.

Redispatch repairs execution failure only; it must not change the evidence pack, selected role, or
repair depth. A successful redispatch removes the stale gap but keeps the audit trail.
