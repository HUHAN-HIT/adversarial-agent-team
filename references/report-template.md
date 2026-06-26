# Report Template (single source of truth)

The Scribe renders this. The **Dimension Reviews** section is generated dynamically from whichever
dimensions ran — it is not a fixed list of code headings — so the same template serves code and
goal/strategy reviews.

```markdown
# Adversarial Review Report

<!-- Mode D only: paste this callout verbatim at the very top -->
> ⚠️ **Mode D (single context):** reviewer independence was only partial — all roles ran in one
> context. Overall confidence is capped at `medium`. Weigh findings accordingly.

<!-- Incomplete/failed/aborted run only: paste this callout before Executive Summary -->
> **Review incomplete:** `run_status.status` was not `completed` or `completed_with_gaps`, or
> `safe_to_use_decision` was `false`. Treat any decision below as non-final until the missing phase
> is rerun or the review is restarted.

## Executive Summary
- Target:
- Decision:            # accept | accept_with_conditions | revise | block | investigate
- Risk Level:          # critical | high | medium | low
- Confidence:          # high | medium | low
- Required Changes:    # count + one-line gist
- Mode:                # A/B/C/C2/D — add "(independence simulated)" for Mode D
- Run Status:          # completed | completed_with_gaps | incomplete | failed | aborted
- Safe To Use Decision:# true only when the required decision phase completed

## Final Decision
State the decision and the single most important reason for it.

## Strongest Pro Case
Best evidence-backed arguments for accepting the target.

## Strongest Con Case
Best evidence-backed arguments against accepting the target.

## Key Findings
| Severity | Confidence | Finding | Evidence | Recommendation |
| --- | --- | --- | --- | --- |

## Dimension Reviews
<!-- One subsection per dimension that actually ran. The set is dynamic. -->
### {dimension-name}
- Summary:
- Notable findings:

## Disputed Points
Disagreements that were not fully resolved. Preserve them; do not force consensus.

## Arbiter Reasoning
Why the decision follows from the evidence. Label any arbiter-discovered gaps.

## Required Changes
Changes required before approval (the blockers and their fixes).

## Plan Loop
<!-- Conditional: render only when adversarial_plan_loop was explicitly run. Do not invent plan artifacts. -->
- Initial Plan ID:
- Plan Review Decision: # accept | accept_with_conditions | revise | block | investigate
- Accepted Plan ID:     # omit when blocked/investigate
- Blocked / Investigation State:
- Verification Commands:
- Residual Risks:

This verdict applies to the generated plan. It preserves the source review decision and does not
prove any implementation has already been completed.
## Remediation Plan
<!-- Conditional: render only when a repairPlan was explicitly produced. Do not invent one. -->
- Plan ID:
- Source Decision:
- Objectives:
- Steps:
- Validation:
- Rollback / Abort:
- Residual Risks:

## Repair Plan Review
<!-- Conditional: render only when repairPlanReview was explicitly run. Keep this concise; link or append raw outputs. -->
- Repair Plan Decision:   # accept | accept_with_conditions | revise | block | investigate
- Coverage:               # addressed / partial / missing / unverifiable count
- Top Required Plan Fixes: # top 3, if any
- Important Residual Risks:

This verdict applies to the repair plan only. It does not change the original target decision or
prove the target has already been fixed.

## Optional Improvements
Non-blocking improvements.

## Open Questions
Questions needing user or domain-owner input. Include any missing role, failed phase, or abandoned
run state from `run_status` here when the run did not fully complete.

## Appendix: Raw Agent Outputs
Per-role YAML. Include on request, or by default for Full / high-stakes reviews. If the combined
raw output exceeds ~150 lines, inline a per-role summary and link to the stored full outputs
instead of pasting everything.
```
