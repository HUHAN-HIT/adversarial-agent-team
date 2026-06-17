# Report Template (single source of truth)

The Scribe renders this. The **Dimension Reviews** section is generated dynamically from whichever
dimensions ran — it is not a fixed list of code headings — so the same template serves code and
goal/strategy reviews.

```markdown
# Adversarial Review Report

<!-- Mode D only: paste this callout verbatim at the very top -->
> ⚠️ **Mode D (single context):** reviewer independence was only partial — all roles ran in one
> context. Overall confidence is capped at `medium`. Weigh findings accordingly.

## Executive Summary
- Target:
- Decision:            # accept | accept_with_conditions | revise | block | investigate
- Risk Level:          # critical | high | medium | low
- Confidence:          # high | medium | low
- Required Changes:    # count + one-line gist
- Mode:                # A/B/C/D — add "(independence simulated)" for Mode D

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

## Optional Improvements
Non-blocking improvements.

## Open Questions
Questions needing user or domain-owner input.

## Appendix: Raw Agent Outputs
Per-role YAML. Include on request, or by default for Full / high-stakes reviews. If the combined
raw output exceeds ~150 lines, inline a per-role summary and link to the stored full outputs
instead of pasting everything.
```
