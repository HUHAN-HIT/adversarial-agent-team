# Output Schema

Every role emits one fenced ```yaml block matching the schema for its phase. Strict, fenced YAML
keeps outputs machine-mergeable; malformed YAML should be rejected and regenerated.

## Evidence Pack (Coordinator, Phase 2)

```yaml
target_type: code | pr | architecture | plan | strategy | decision
target_summary:
scope:
constraints:
success_criteria:
evidence:
  files:        # paths or excerpts — not whole trees
  diffs:
  tests:
  docs:
  links:
known_unknowns:   # includes anything omitted when chunking/sampling large input
mode: A | B | C | C2 | D
review_size: minimal | standard | full
roles_selected:   # list of role names dispatched
```

## Findings (Pro / Con / Dimension reviewers, Phase 3)

```yaml
agent:                       # role name, e.g. security-reviewer
stance: pro | con | dimension
dimension:                   # set only when stance == dimension
summary:
claims:
  - id:                      # short stable id, e.g. C1
    claim:
    evidence:
    severity: blocker | high | medium | low | note
    confidence: high | medium | low
    recommended_action:
open_questions:
```

## Cross-Examination (Cross-Examiner, Phase 4)

```yaml
strongest_pro_claims:        # list of claim ids + one-line why
strongest_con_claims:
disputed_points:             # where pro and con directly conflict
unsupported_claims:          # asserted without evidence
evidence_gaps:
questions_for_arbiter:
```

## Arbitration (Arbiter, Phase 5)

```yaml
decision: accept | accept_with_conditions | revise | block | investigate
risk_level: critical | high | medium | low
confidence: high | medium | low
required_changes:            # the blockers and their fixes
optional_improvements:
residual_risks:
arbiter_discovered_gaps:     # new issues not raised by any reviewer (may be empty)
reasoning:
```

The Scribe consumes all of the above to render `report-template.md`.
