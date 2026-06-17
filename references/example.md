# Worked Example — reviewing a small auth diff (Mode A, Standard)

A compact end-to-end run so you can see the schema in motion. Target: a PR adding a password-reset
endpoint. (Excerpted — real findings would be fuller.)

## Phase 2 — Evidence Pack (Coordinator)

```yaml
target_type: pr
target_summary: Adds POST /auth/reset-password that emails a reset token.
scope: src/auth/reset.ts, src/auth/token.ts, tests/auth/reset.test.ts
constraints: Must not leak whether an email exists; tokens expire in 15m.
success_criteria: Reset works; no user-enumeration; token single-use.
evidence:
  files: [src/auth/reset.ts, src/auth/token.ts]
  diffs: "+ generateToken(email) returns a 6-digit code stored in tokens table"
  tests: [tests/auth/reset.test.ts — happy path only]
  docs: []
  links: [PR #214]
known_unknowns: rate-limiting config is not in the diff
mode: A
review_size: standard
roles_selected: [pro, con, security-reviewer, test-reviewer, arbiter, scribe]
```

## Phase 3 — Independent findings (excerpts)

```yaml
agent: security-reviewer
stance: dimension
dimension: security
summary: One blocker (enumeration), one high (token entropy).
claims:
  - id: S1
    claim: Returns 404 for unknown email but 200 for known — enables user enumeration.
    evidence: src/auth/reset.ts:31-38 branches on user existence.
    severity: blocker
    confidence: high
    recommended_action: Always return 200 with a generic message.
  - id: S2
    claim: 6-digit numeric token (10^6 space) is brute-forceable within 15m with no lockout.
    evidence: token.ts:12 generateToken; no attempt cap found in diff.
    severity: high
    confidence: medium
    recommended_action: Use a 128-bit URL-safe token, or add attempt lockout.
open_questions: [Is there gateway-level rate limiting outside the diff?]
```

```yaml
agent: adversarial-pro
stance: pro
summary: Core flow is correct and honors the 15m-expiry constraint.
claims:
  - id: P1
    claim: Token expiry is enforced server-side at verify time.
    evidence: token.ts:24 checks created_at + 15m.
    severity: note
    confidence: high
    recommended_action: Keep as-is.
open_questions: []
```

## Phase 5 — Arbitration

```yaml
decision: block
risk_level: critical
confidence: high
required_changes:
  - "S1: remove user-enumeration (uniform 200 response)."
optional_improvements:
  - "S2: stronger token or lockout (would be accept_with_conditions if rate-limiting is confirmed)."
residual_risks: Brute-force exposure depends on unverified external rate limiting.
arbiter_discovered_gaps: []
reasoning: >
  S1 is an enumeration blocker against an explicit success criterion, so the decision is block
  regardless of the valid pro point P1. S2 is high but conditionally acceptable. Not an average of
  votes — one blocker decides it.
```

## Phase 6 — Report (excerpt)

> Decision: **block** · Risk: **critical** · Confidence: high · Required changes: 1 (fix
> enumeration). Strongest con: S1 (enumeration). Strongest pro: P1 (expiry correct). Disputed
> points: none material. Open question: external rate limiting — S2 hinges on it.

Note how `decision_impact` never appears on a finding: severity carries the signal (`blocker` →
block), and the arbiter aggregates.
