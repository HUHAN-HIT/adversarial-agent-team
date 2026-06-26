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

## Run Completion Status (tool envelope, every C2 phase)

C2 tools return this alongside their phase artifacts. It is additive: existing `findings`,
`crossExam`, `arbitration`, `repairPlan`, `repairPlanReview`, and `gaps` shapes stay unchanged.

```yaml
run_status:
  status: completed | completed_with_gaps | incomplete | failed | aborted
  completed_phases:          # e.g. [role_review, cross_examination, arbitration]
  incomplete_phase:          # role_review | cross_examination | arbitration | repair_planning | repair_plan_validation | null
  reason:
  safe_to_use_decision: true | false
  redispatch_attempts:
    - role:
      phase:
      attempt:               # starts at 1; bounded by maxRedispatchPerRole
      reason_kind: timeout | empty | schema_violation | error
      reason_detail:
      success: true | false
  gaps_count:
```

`completed` means every required phase for that tool call finished. `completed_with_gaps` means the
required phases finished but non-fatal role gaps remain. `incomplete`, `failed`, or `aborted` must
be rendered as an incomplete review; any returned or synthesized decision is not final unless
`safe_to_use_decision: true`.
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

## Remediation Plan (Repair Planner, conditional after Phase 5)

```yaml
plan_id:                         # stable id for this plan, e.g. RP-1
source_decision: accept_with_conditions | revise | block | investigate
source_required_changes:         # derived from arbitration.required_changes, preserving order
  - id: RC1
    text:
objectives:
steps:
  - id: STEP1
    addresses:                   # required-change ids and/or finding claim ids, e.g. [RC1, S1]
    action:
    files_or_interfaces:
    validation:
    dependencies:
    risks:
non_goals:
assumptions:
rollback:
verification_commands:
residual_risks:
```

A remediation plan is a separate artifact. Do not add it to the arbitration block, and do not treat
plan acceptance as proof that the original target has already been fixed.

## Repair Plan Review Result (Phase 7)

```yaml
repair_plan_id:
review_purpose: repair_plan_review
repair_depth: 1                  # bounded; do not recurse into another repair plan automatically
coverage:
  - required_change: RC1
    status: addressed | partial | missing | unverifiable
    evidence:
findings:                        # reuse Findings[] from Phase 3
crossExam:                       # reuse Cross-Examination when run
arbitration:                     # reuse Arbitration schema; judges the repair plan only
gaps:
```

If any required change is `missing` or `unverifiable`, the repair-plan arbitration must not be
`accept`.
The Scribe consumes all of the above to render `report-template.md`.
