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

## Phase 6 — Final Report

The Scribe renders `report-template.md` with dynamic dimension reviews. Preserve real disagreement;
do not collapse it into false consensus.

## Robustness (all modes)

- **Invalid YAML from a role:** reject and re-prompt once. If still unparseable, capture the output
  as a free-text finding flagged `schema_violation` so the Arbiter discounts it.
- **Empty or runaway role:** the Coordinator retries once, then proceeds and records the missing
  role under the report's Open Questions / known gaps — never silently drop it.
- **Mode B teammate stalls:** the lead reassigns or proceeds, noting the gap.
