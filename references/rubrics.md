# Rubrics

Two **distinct** axes — never conflate them:

- **`severity`** rates a *single finding*.
- **`risk_level`** rates the *overall decision*.

## Severity (per finding)

| Value | Meaning |
| --- | --- |
| `blocker` | Must fix before acceptance — correctness, security, data loss, deploy failure, or major decision failure. |
| `high` | Serious; materially raises risk; may be acceptable with mitigation. |
| `medium` | Meaningful; address soon or explicitly accept. |
| `low` | Minor / polish. |
| `note` | Observation or tradeoff; no action required. |

## Confidence (per finding)

| Value | Meaning |
| --- | --- |
| `high` | Direct evidence from code, tests, logs, specs, or reliable sources. |
| `medium` | Strong inference from available evidence. (Mode D caps the report's *overall* confidence here.) |
| `low` | Plausible concern needing confirmation. |

## Decision (the arbiter's `decision`)

| Value | Meaning |
| --- | --- |
| `accept` | No blockers; residual risk low. |
| `accept_with_conditions` | Acceptable only if the listed conditions are met. |
| `revise` | Needs changes before approval, but the path is clear. |
| `block` | One or more blockers remain; do not proceed. |
| `investigate` | Evidence insufficient for a responsible decision. |

Findings carry no decision value of their own; the arbiter aggregates severity + confidence +
evidence into the decision above.

## Risk Level (overall decision)

`critical | high | medium | low`.

## Severity → Risk mapping (guidance, not a hard rule)

- Any `blocker` finding ⇒ overall `risk_level: critical` and `decision: block` or
  `investigate`.
- A cluster of `high` findings with no blockers ⇒ `risk_level: high` with `revise` or
  `accept_with_conditions`.
- Only `medium`/`low`/`note` ⇒ `risk_level: medium`/`low` with `accept` or
  `accept_with_conditions`.

The arbiter may deviate from this mapping but must justify the deviation in `reasoning`.
