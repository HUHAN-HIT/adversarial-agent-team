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

## Initial Plan (Solution Designer, Plan Loop only)

```yaml
plan_id:                         # stable id, e.g. IP1
goal:
assumptions:
steps:
  - id: S1
    action:
    rationale:
    owner:
    depends_on:
validation:
risks:
open_questions:
```

This is a candidate plan, not an accepted plan. It must be reviewed as `target_type: plan` before
being synthesized into an `AcceptedPlan`.

## Accepted Plan (Plan Synthesizer, Plan Loop only)

```yaml
plan_id:                         # stable id, e.g. AP1
source_initial_plan_id:
source_decision: accept | accept_with_conditions | revise
decision_preserved: true
changes_applied:
  - required_change_id: RC1
    change:
final_steps:
  - id: S1
    action:
    rationale:
verification_commands:
residual_risks:
```

`AcceptedPlan` is allowed only when plan-review arbitration is `accept`, `accept_with_conditions`,
or `revise`. It is forbidden for `block` and `investigate`; those return `blocked_reason` or
`investigation_plan` instead.

## Plan Loop Result (tool envelope)

```yaml
initialPlan:                     # Initial Plan schema
review:
  findings:                      # Findings[] from plan review
  crossExam:                     # optional Cross-Examination
  arbitration:                   # Arbitration over the plan
acceptedPlan:                    # Accepted Plan schema, only when synthesis is allowed
blocked_reason:                  # present instead of acceptedPlan for block/failure
investigation_plan:              # present instead of acceptedPlan for investigate
plan_loop_depth: 1
allow_plan_loop: false
gaps:
run_status:
```

Plan Loop is bounded. It must not automatically produce a plan-of-plan or recurse into another
planning pass.
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
