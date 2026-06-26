// adversarial-engine.mjs
// ---------------------------------------------------------------------------
// adversarial-agent-team · Mode C2（原生 OpenCode 真团队）的纯引擎层。
//
// 设计真源：references/opencode-native-team-plugin-design.md（Draft v2.1 + §10.1 M0 回填）。
// 角色 prompt 真源：references/roles.md —— 改 roles.md 必须同步本文件 ROLE_PROMPTS（D7 镜像约束）。
// 输出 schema 真源：references/output-schema.md —— 改 schema 必须同步本文件校验器（§8 同步约束）。
//
// 本层零 host 依赖：不 import @opencode-ai/plugin，只接收注入的 `client`
// （ReturnType<createOpencodeClient>）。因此可被 scripts/ 的 harness 直接 import 真跑，
// 也可被 adversarial-team.js（plugin shim）包一层注册成工具。
//
// M0 实测锁定（opencode 1.2.27 + glm-5，见设计 §10.1）：
//   - session id 取值 = res.data.id（防御式回退见 sid()）
//   - 角色注入 = noReply 两步注入（V2 PASS）；agent 绑定弃用（V1 假阳性）
//   - 1.2.27 SDK 无 body.format / 无 structured_output → 走 fenced-text 解析，读 res.data.parts
//   - body.model = { providerID, modelID }（V7 object）
//   - reviewer 只读 = 软约束（V10 假阳性）；session 间 API 级隔离成立（V8 PASS）
// ---------------------------------------------------------------------------

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ============================ 枚举（对接 output-schema.md）====================
const SEVERITY = ["blocker", "high", "medium", "low", "note"];
const CONFIDENCE = ["high", "medium", "low"];
const STANCE = ["pro", "con", "dimension"];
const DECISION = ["accept", "accept_with_conditions", "revise", "block", "investigate"];
const RISK = ["critical", "high", "medium", "low"];
const COVERAGE_STATUS = ["addressed", "partial", "missing", "unverifiable"];
export const SCHEMA_ENUMS = Object.freeze({
  severity: SEVERITY,
  confidence: CONFIDENCE,
  stance: STANCE,
  decision: DECISION,
  risk_level: RISK,
  coverage_status: COVERAGE_STATUS,
});

// ============================ C2 专属 shared contract（设计 §6.6 / B1）========
// 注意：剔除了 roles.md 的「In Mode D ...」条款，换成 C2 专属声明，避免 reviewer
// 误以为自己在 Mode D 而错误下调置信度。
export const SHARED_CONTRACT_C2 = `Use evidence first; label speculation explicitly.
Separate severity (how bad a finding is) from confidence (how sure you are).
Do not duplicate another role's job unless necessary.
Prefer actionable findings over commentary.
Preserve real disagreement.

You are running in Mode C2 (OpenCode native team plugin): you are an isolated
session. Other reviewers run in their own sessions and their outputs are not
visible to you. Your independence is structural, not a self-check.`;

// ============================ ROLE_PROMPTS（镜像 roles.md，D7）================
// 覆盖独立 session 会注入的角色：pro / con / 12 维度 / cross-examiner / arbiter。
// coordinator 与 scribe 由 lead 主 session 担任（D6/D8），不进此表。
const DIMENSIONS = {
  "correctness-reviewer": "logic bugs, race conditions, state errors, boundary cases",
  "security-reviewer": "auth, injection, secrets, unsafe IO, data exposure, dependency risk",
  "test-reviewer": "missing coverage, weak assertions, untested error paths, flaky tests",
  "architecture-reviewer": "boundaries, coupling, abstractions, API contracts, maintainability",
  "performance-reviewer": "complexity, memory, latency, unnecessary work, scaling limits",
  "ops-reviewer": "migration, deployment, observability, rollback, config, compatibility",
  "ux-api-reviewer": "public interface, developer experience, error messages, user impact",
  "feasibility-reviewer": "execution realism, dependencies, resource constraints",
  "risk-reviewer": "downside, uncertainty, reversibility, second-order effects",
  "impact-reviewer": "expected value, opportunity cost, stakeholder impact",
  "assumption-reviewer": "fragile assumptions, missing data, ambiguous definitions",
  "implementation-reviewer": "sequencing, ownership, milestones, operating model",
};

export const ROLE_PROMPTS = {
  pro: `You are the Pro agent (stance: pro). Defend the target with evidence.
- Identify strengths, valid tradeoffs, and reasons to accept.
- Explain why apparent risks may be acceptable and where the solution fits its constraints.
- Defend only claims backed by evidence; state the conditions required for acceptance.
Emit a findings block with stance: pro.`,

  con: `You are the Con agent (stance: con). Attack the target with evidence.
- Challenge assumptions; find edge cases, failure modes, missing tests, hidden dependencies, and unclear claims.
- Argue for revision or rejection when evidence supports it.
- No vague negativity: every critique needs evidence or a falsifiable concern. Unsupported worries become low-confidence investigate items.
Emit a findings block with stance: con.`,

  "cross-examiner": `You are the Cross-Examiner. You are the first role allowed to see all reviewers' findings.
- Compare pro and con claims; separate evidence-backed from speculative.
- Force each side to address the strongest opposing argument.
- Also sharpen dimension-vs-dimension and dimension-vs-pro/con disputes (C2 extension).
- Mark unresolved disputes and evidence gaps for the arbiter.
Emit a cross-exam block.`,

  arbiter: `You are the Arbiter. Make the decision.
- Weigh evidence, severity, confidence, and reversibility.
- Decide accept | accept_with_conditions | revise | block | investigate; set overall risk_level; separate blockers from non-blockers; give next actions.
- Judge supplied evidence first; label any new issue an arbiter-discovered gap.
- Never average opinions. One blocker can outweigh many approvals.
Emit an arbitration block.`,

  "solution-designer": `You are the Solution Designer. Produce an implementation-quality InitialPlan before review.
- Turn the user's goal and evidence into a concrete, sequenced plan.
- State assumptions, validation, risks, and open questions explicitly.
- Do not claim the plan is accepted; it still requires adversarial review.
Emit an InitialPlan block.`,

  "plan-synthesizer": `You are the Plan Synthesizer. Produce an AcceptedPlan only after adversarial arbitration permits synthesis.
- Apply every required_change from the arbiter using RC1, RC2, ... ids.
- Preserve the source arbitration decision; plan acceptance does not change the original target decision.
- Do not start another plan loop or ask for a repair plan for this plan.
Emit an AcceptedPlan block.`,
  "repair-planner": `You are the Repair Planner. Convert an arbitration result and its required_changes into a bounded remediation plan.
- Do not re-litigate the original review decision.
- Do not place the repair plan inside the arbitration object.
- Derive stable required-change ids RC1, RC2, ... from arbitration.required_changes in order.
- Each required change must be addressed by at least one concrete plan step.
- Include validation, rollback/abort guidance, assumptions, and residual risks.
- The plan is a proposal to fix the target; it does not change the target decision.
Emit a remediation plan block.`,
};
for (const [name, focus] of Object.entries(DIMENSIONS)) {
  ROLE_PROMPTS[name] = `You are the ${name} (stance: dimension, dimension: ${name.replace("-reviewer", "")}).
Review ONLY this focus area and ignore the rest: ${focus}.
Emit a findings block with stance: dimension and the matching dimension name.`;
}

// ============================ 输出格式指令（fenced-text，无 json_schema）======
function findingsInstruction(role) {
  const dimLine = role.stance === "dimension" ? `\ndimension: ${role.dimension || role.name.replace("-reviewer", "")}` : "";
  return `Return ONLY a single fenced code block (\`\`\`yaml). No prose outside the block.
JSON inside the block is also accepted (JSON is valid YAML). Use EXACTLY these keys:

\`\`\`yaml
agent: ${role.name}
stance: ${role.stance}${dimLine}
summary: <2-4 sentences>
claims:
  - id: C1
    claim: <the claim>
    evidence: <evidence or reference>
    severity: blocker|high|medium|low|note
    confidence: high|medium|low
    recommended_action: <action>
open_questions:
  - <question, or omit the key>
\`\`\`

Rules: each claim needs id, claim, evidence, severity, confidence. Keep severity (impact)
separate from confidence (certainty). If unsure about YAML indentation, emit a JSON object
inside the block instead.`;
}

function crossExamInstruction() {
  return `Return ONLY a single fenced code block (\`\`\`yaml; JSON also accepted). Use EXACTLY these keys,
each a list of short strings:

\`\`\`yaml
strongest_pro_claims:
  - <claim id + one-line why>
strongest_con_claims:
  - <claim id + one-line why>
disputed_points:
  - <where sides directly conflict>
unsupported_claims:
  - <asserted without evidence>
evidence_gaps:
  - <missing evidence>
questions_for_arbiter:
  - <question>
\`\`\`

No prose outside the block.`;
}

function arbitrationInstruction() {
  return `Return ONLY a single fenced code block (\`\`\`yaml; JSON also accepted). Use EXACTLY these keys:

\`\`\`yaml
decision: accept|accept_with_conditions|revise|block|investigate
risk_level: critical|high|medium|low
confidence: high|medium|low
required_changes:
  - <blocker and its fix>
optional_improvements:
  - <nice-to-have>
residual_risks:
  - <risk remaining after changes>
arbiter_discovered_gaps:
  - <new issue not raised by any reviewer, may be empty>
reasoning: <why this decision; never average — one blocker can outweigh many approvals>
\`\`\`

No prose outside the block.`;
}

function initialPlanInstruction() {
  return `Return ONLY a single fenced code block (\`\`\`yaml; JSON also accepted). Use EXACTLY these keys:

\`\`\`yaml
plan_id: IP1
goal: <goal this plan solves>
assumptions:
  - <assumption>
steps:
  - id: S1
    action: <specific implementation/design action>
    rationale: <why this step exists>
validation:
  - <test, command, review, or evidence check>
risks:
  - <risk>
open_questions:
  - <question, or omit the key>
\`\`\`

No prose outside the block. This is an InitialPlan, not an accepted final plan.`;
}

function acceptedPlanInstruction(initialPlan, arbitration) {
  const required = (arbitration?.required_changes || []).map((c, i) => `RC${i + 1}: ${c}`).join("\n") || "<none>";
  return `Return ONLY a single fenced code block (\`\`\`yaml; JSON also accepted). Use EXACTLY these keys:

Required changes to cover:
${required}

\`\`\`yaml
plan_id: AP1
source_initial_plan_id: ${initialPlan?.plan_id || "IP1"}
source_decision: ${arbitration?.decision || "revise"}
decision_preserved: true
changes_applied:
  - required_change_id: RC1
    change: <how the required change is applied>
final_steps:
  - id: S1
    action: <final concrete action>
    rationale: <why this action remains>
verification_commands:
  - <command or manual verification>
residual_risks:
  - <risk remaining after the plan>
\`\`\`

No prose outside the block. Do not change the source decision. Do not generate another plan loop.`;
}
function repairPlanInstruction() {
  return `Return ONLY a single fenced code block (\`\`\`yaml; JSON also accepted). Use EXACTLY these keys:

\`\`\`yaml
plan_id: RP-1
source_decision: accept_with_conditions|revise|block|investigate
source_required_changes:
  - id: RC1
    text: <required change text from arbitration.required_changes[0]>
objectives:
  - <what the repair plan must accomplish>
steps:
  - id: STEP1
    addresses: [RC1]
    action: <concrete repair action>
    files_or_interfaces:
      - <file, API, schema, or interface likely affected; may be empty if unknown>
    validation:
      - <test, command, or evidence needed to prove the step>
    dependencies:
      - <prerequisite, may be empty>
    risks:
      - <new risk this step may introduce, may be empty>
non_goals:
  - <explicitly out of scope, may be empty>
assumptions:
  - <assumption, may be empty>
rollback:
  - <rollback or abort path>
verification_commands:
  - <command or check>
residual_risks:
  - <risk remaining after the repair plan>
\`\`\`

Rules:
- Derive RC1, RC2, ... from arbitration.required_changes in order.
- Every source_required_changes id must appear in at least one step.addresses entry.
- Do not change the original target decision; this is only a proposed repair plan.
No prose outside the block.`;
}

function repairPlanReviewArbitrationInstruction() {
  return `Return ONLY a single fenced code block (\`\`\`yaml; JSON also accepted). Use the normal arbitration keys:

\`\`\`yaml
decision: accept|accept_with_conditions|revise|block|investigate
risk_level: critical|high|medium|low
confidence: high|medium|low
required_changes:
  - <changes required to the repair plan itself, not to the original target>
optional_improvements:
  - <non-blocking repair-plan improvement>
residual_risks:
  - <risk remaining if this repair plan is followed>
arbiter_discovered_gaps:
  - <new gap in the repair plan review, may be empty>
reasoning: <judge whether the repair plan covers the original required_changes; do not claim the target is fixed>
\`\`\`

Rules:
- Arbitrate the repair plan, not the original target.
- Do not generate a new repair plan or a repair-plan-of-repair-plan.
- If any original required change is missing or unverifiable, decision must not be accept.
No prose outside the block.`;
}
const REPARSE_NUDGE =
  "Your previous reply could not be parsed. Output ONLY one fenced code block with the required keys and NOTHING else (no prose, no explanation before or after).";

// ============================ fenced 块提取 + 解析 ===========================
export function extractFencedBlock(text) {
  if (!text) return "";
  const m = String(text).match(/```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/);
  if (m) return m[1];
  return String(text).trim(); // 无 fence：可能是裸 JSON/YAML
}

// 先 JSON.parse（JSON ⊂ YAML，glm 常直接出 JSON），失败再走受限 YAML 子集解析。
export function parseStructured(text) {
  const block = extractFencedBlock(text);
  try {
    return { value: JSON.parse(block), via: "json" };
  } catch {}
  const v = parseYamlSubset(block);
  if (v && typeof v === "object") return { value: v, via: "yaml" };
  throw new Error("unparseable structured block");
}

// 受限 YAML 子集解析器 —— 只覆盖 FINDINGS/CROSS_EXAM/ARBITRATION 的浅层形状：
// 顶层 map；值 = 标量 | 标量列表 | 单层 map 的列表（claims）。key 限定为标识符，
// 避免把含冒号的散文/问题误判成 map item。失败即抛 → 上层重提一次 / 记 gap。
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;
export function parseYamlSubset(src) {
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const indentOf = (l) => (l.match(/^( *)/)[1] || "").length;
  const skippable = (l) => l.trim() === "" || l.trim().startsWith("#");

  function parseScalar(s) {
    s = s.trim();
    if (s === "" || s === "~" || /^null$/i.test(s)) return null;
    if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    if (s.startsWith("[") && s.endsWith("]")) {
      const inner = s.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(",").map((item) => parseScalar(item.trim())).filter((item) => item !== "");
    }
    return s;
  }
  function parseBlockScalar(baseIndent, marker) {
    const fold = marker.startsWith(">");
    const out = [];
    while (i < lines.length) {
      if (lines[i].trim() === "") { out.push(""); i++; continue; }
      if (indentOf(lines[i]) <= baseIndent) break;
      out.push(lines[i].replace(new RegExp(`^ {0,${baseIndent + 2}}`), ""));
      i++;
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    return fold ? out.join(" ").trim() : out.join("\n");
  }
  function nextMeaningfulIndent() {
    let j = i;
    while (j < lines.length && skippable(lines[j])) j++;
    return j < lines.length ? indentOf(lines[j]) : -1;
  }
  function parseValueAfterKey(rest, keyIndent) {
    if (rest === undefined || rest === "") {
      if (nextMeaningfulIndent() > keyIndent) return parseBlock(keyIndent + 1);
      return null;
    }
    if (/^[|>]-?$/.test(rest)) return parseBlockScalar(keyIndent, rest);
    return parseScalar(rest);
  }
  function parseMap(ind) {
    const obj = {};
    while (i < lines.length) {
      if (skippable(lines[i])) { i++; continue; }
      const cur = indentOf(lines[i]);
      if (cur < ind) break;
      if (cur > ind) { i++; continue; }
      const body = lines[i].slice(ind);
      if (body.startsWith("- ")) break; // 这是序列，不是 map
      const m = body.match(KEY_RE);
      if (!m) { i++; continue; }
      const key = m[1];
      const rest = m[2];
      i++;
      obj[key] = parseValueAfterKey(rest, ind);
    }
    return obj;
  }
  function parseSeq(ind) {
    const arr = [];
    while (i < lines.length) {
      if (skippable(lines[i])) { i++; continue; }
      const cur = indentOf(lines[i]);
      if (cur < ind) break;
      if (cur > ind) { i++; continue; }
      const body = lines[i].slice(ind);
      if (!body.startsWith("- ")) break;
      const after = body.slice(2);
      const m = after.match(KEY_RE);
      if (m) {
        // map item：首键在 "- " 同行，后续键缩进在 ind 之下（> ind）
        const item = {};
        i++;
        item[m[1]] = parseValueAfterKey(m[2], ind + 1);
        while (i < lines.length) {
          if (skippable(lines[i])) { i++; continue; }
          const c = indentOf(lines[i]);
          if (c <= ind) break; // 回到序列层或更外
          const mm = lines[i].slice(c).match(KEY_RE);
          if (!mm) { i++; continue; }
          i++;
          item[mm[1]] = parseValueAfterKey(mm[2], c);
        }
        arr.push(item);
      } else {
        i++;
        arr.push(parseScalar(after));
      }
    }
    return arr;
  }
  function parseBlock(minIndent) {
    while (i < lines.length && skippable(lines[i])) i++;
    if (i >= lines.length) return null;
    const ind = indentOf(lines[i]);
    if (ind < minIndent) return null;
    return lines[i].slice(ind).startsWith("- ") ? parseSeq(ind) : parseMap(ind);
  }
  return parseBlock(0);
}

// ============================ 校验器（对接 output-schema.md）==================
// 策略：结构性缺失（claims 全无 / 非对象）→ 硬失败（触发重提/gap）；
//       枚举漂移 → 就近 coerce（'note'/'low'/...）并记 warning，避免对 glm 小偏差过度失败。
const asArray = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
const coerceEnum = (v, allowed, fallback) => {
  const s = String(v ?? "").trim().toLowerCase();
  return allowed.includes(s) ? s : fallback;
};
const strList = (x) => asArray(x).map((s) => String(s).trim()).filter(Boolean);

export function validateFindings(o, role) {
  if (!o || typeof o !== "object") return { ok: false, errors: ["not an object"] };
  const warnings = [];
  const claimsRaw = asArray(o.claims);
  if (claimsRaw.length === 0) return { ok: false, errors: ["claims empty/missing"] };
  const claims = claimsRaw.map((c, idx) => {
    c = c || {};
    const id = String(c.id ?? `C${idx + 1}`).trim();
    const claim = String(c.claim ?? c.summary ?? "").trim();
    if (!claim) warnings.push(`claim ${id}: missing text`);
    const out = {
      id,
      claim,
      evidence: String(c.evidence ?? "").trim(),
      severity: coerceEnum(c.severity, SEVERITY, "note"),
      confidence: coerceEnum(c.confidence, CONFIDENCE, "low"),
    };
    if (c.recommended_action != null) out.recommended_action = String(c.recommended_action).trim();
    return out;
  });
  if (!claims.some((c) => c.claim)) return { ok: false, errors: ["no claim has text"] };
  const finding = {
    agent: role?.name ?? String(o.agent ?? "").trim(),
    stance: role?.stance ?? coerceEnum(o.stance, STANCE, "dimension"),
    summary: String(o.summary ?? "").trim(),
    claims,
  };
  const dim = role?.dimension ?? o.dimension;
  if (finding.stance === "dimension" && dim) finding.dimension = String(dim).trim().replace("-reviewer", "");
  const oq = strList(o.open_questions);
  if (oq.length) finding.open_questions = oq;
  return { ok: true, value: finding, warnings };
}

export function validateCrossExam(o) {
  if (!o || typeof o !== "object") return { ok: false, errors: ["not an object"] };
  return {
    ok: true,
    value: {
      strongest_pro_claims: strList(o.strongest_pro_claims),
      strongest_con_claims: strList(o.strongest_con_claims),
      disputed_points: strList(o.disputed_points),
      unsupported_claims: strList(o.unsupported_claims),
      evidence_gaps: strList(o.evidence_gaps),
      questions_for_arbiter: strList(o.questions_for_arbiter),
    },
  };
}

export function validateArbitration(o) {
  if (!o || typeof o !== "object") return { ok: false, errors: ["not an object"] };
  return {
    ok: true,
    value: {
      decision: coerceEnum(o.decision, DECISION, "investigate"),
      risk_level: coerceEnum(o.risk_level, RISK, "medium"),
      confidence: coerceEnum(o.confidence, CONFIDENCE, "low"),
      required_changes: strList(o.required_changes),
      optional_improvements: strList(o.optional_improvements),
      residual_risks: strList(o.residual_risks),
      arbiter_discovered_gaps: strList(o.arbiter_discovered_gaps),
      reasoning: String(o.reasoning ?? "").trim(),
    },
  };
}

function normalizePlanSteps(x) {
  return asArray(x).map((s, idx) => {
    if (typeof s === "string") return { id: `S${idx + 1}`, action: s.trim() };
    s = s || {};
    const out = {
      id: String(s.id ?? `S${idx + 1}`).trim(),
      action: String(s.action ?? s.step ?? s.task ?? "").trim(),
    };
    if (s.rationale != null) out.rationale = String(s.rationale).trim();
    if (s.owner != null) out.owner = String(s.owner).trim();
    if (s.depends_on != null) out.depends_on = strList(s.depends_on);
    return out;
  }).filter((s) => s.action);
}

function normalizeChangesApplied(x) {
  return asArray(x).map((c, idx) => {
    if (typeof c === "string") return { required_change_id: `RC${idx + 1}`, change: c.trim() };
    c = c || {};
    return {
      required_change_id: String(c.required_change_id ?? c.id ?? `RC${idx + 1}`).trim(),
      change: String(c.change ?? c.action ?? c.summary ?? "").trim(),
    };
  }).filter((c) => c.change);
}

export function validateInitialPlan(o) {
  if (!o || typeof o !== "object") return { ok: false, errors: ["not an object"] };
  const errors = [];
  const steps = normalizePlanSteps(o.steps);
  const validation = strList(o.validation);
  const value = {
    plan_id: String(o.plan_id ?? "").trim(),
    goal: String(o.goal ?? "").trim(),
    assumptions: strList(o.assumptions),
    steps,
    validation,
    risks: strList(o.risks),
    open_questions: strList(o.open_questions),
  };
  if (!value.plan_id) errors.push("plan_id missing");
  if (!value.goal) errors.push("goal missing");
  if (!steps.length) errors.push("steps empty/missing");
  if (!validation.length) errors.push("validation empty/missing");
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function validateAcceptedPlan(o, initialPlan, arbitration) {
  if (!o || typeof o !== "object") return { ok: false, errors: ["not an object"] };
  const errors = [];
  const final_steps = normalizePlanSteps(o.final_steps ?? o.steps);
  const verification_commands = strList(o.verification_commands ?? o.validation);
  const changes_applied = normalizeChangesApplied(o.changes_applied);
  const sourceDecision = coerceEnum(o.source_decision ?? arbitration?.decision, DECISION, "revise");
  const value = {
    plan_id: String(o.plan_id ?? "").trim(),
    source_initial_plan_id: String(o.source_initial_plan_id ?? "").trim(),
    source_decision: sourceDecision,
    decision_preserved: o.decision_preserved === true || String(o.decision_preserved).toLowerCase() === "true",
    changes_applied,
    final_steps,
    verification_commands,
    residual_risks: strList(o.residual_risks),
  };
  if (!value.plan_id) errors.push("plan_id missing");
  if (!value.source_initial_plan_id) errors.push("source_initial_plan_id missing");
  if (initialPlan?.plan_id && value.source_initial_plan_id !== initialPlan.plan_id) errors.push("source_initial_plan_id does not match initial plan");
  if (!value.decision_preserved) errors.push("decision_preserved must be true");
  if (!final_steps.length) errors.push("final_steps empty/missing");
  if (!verification_commands.length) errors.push("verification_commands empty/missing");
  const required = strList(arbitration?.required_changes);
  if (required.length) {
    const covered = new Set(changes_applied.map((c) => c.required_change_id));
    for (let i = 0; i < required.length; i++) {
      if (!covered.has(`RC${i + 1}`)) errors.push(`required_change RC${i + 1} not covered`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function validatePlanLoopResult(o) {
  if (!o || typeof o !== "object") return { ok: false, errors: ["not an object"] };
  const errors = [];
  if (Number(o.plan_loop_depth) !== 1) errors.push("plan_loop_depth must be 1");
  if (o.allow_plan_loop !== false) errors.push("allow_plan_loop must be false");
  const initial = validateInitialPlan(o.initialPlan);
  if (!initial.ok) errors.push(...initial.errors.map((e) => `initialPlan: ${e}`));
  const review = o.review && typeof o.review === "object" ? o.review : null;
  if (!review) errors.push("review missing");
  const arbitration = review?.arbitration ? validateArbitration(review.arbitration).value : null;
  const decision = arbitration?.decision;
  let accepted;
  if (o.acceptedPlan) {
    accepted = validateAcceptedPlan(o.acceptedPlan, initial.value, arbitration);
    if (!accepted.ok) errors.push(...accepted.errors.map((e) => `acceptedPlan: ${e}`));
  }
  if (decision === "block" || decision === "investigate") {
    if (o.acceptedPlan) errors.push("acceptedPlan is forbidden for block/investigate decisions");
    if (!String(o.blocked_reason ?? "").trim() && !String(o.investigation_plan ?? "").trim()) errors.push("blocked_reason or investigation_plan required");
  } else if (decision && !o.acceptedPlan) {
    errors.push("acceptedPlan required when arbitration permits synthesis");
  }
  if (errors.length) return { ok: false, errors };
  const value = {
    initialPlan: initial.value,
    review,
    plan_loop_depth: 1,
    allow_plan_loop: false,
    gaps: asArray(o.gaps),
  };
  if (accepted?.ok) value.acceptedPlan = accepted.value;
  if (o.blocked_reason) value.blocked_reason = String(o.blocked_reason).trim();
  if (o.investigation_plan) value.investigation_plan = String(o.investigation_plan).trim();
  return { ok: true, value };
}
function normalizeRequiredChanges(changes) {
  return strList(changes).map((text, idx) => ({ id: `RC${idx + 1}`, text }));
}

function normalizeRepairStep(step, idx) {
  const s = step || {};
  return {
    id: String(s.id ?? `STEP${idx + 1}`).trim(),
    addresses: strList(s.addresses),
    action: String(s.action ?? "").trim(),
    files_or_interfaces: strList(s.files_or_interfaces),
    validation: strList(s.validation),
    dependencies: strList(s.dependencies),
    risks: strList(s.risks),
  };
}

export function validateRepairPlan(o, expectedRequiredChanges = []) {
  if (!o || typeof o !== "object") return { ok: false, errors: ["not an object"] };
  const warnings = [];
  const sourceRequired = asArray(o.source_required_changes).map((r, idx) => {
    if (r && typeof r === "object") return { id: String(r.id ?? `RC${idx + 1}`).trim(), text: String(r.text ?? "").trim() };
    return { id: `RC${idx + 1}`, text: String(r ?? "").trim() };
  }).filter((r) => r.id && r.text);
  const steps = asArray(o.steps).map(normalizeRepairStep).filter((s) => s.id && s.action);
  const expectedRequired = asArray(expectedRequiredChanges).map((r, idx) => {
    if (r && typeof r === "object") return { id: String(r.id ?? `RC${idx + 1}`).trim(), text: String(r.text ?? "").trim() };
    return { id: `RC${idx + 1}`, text: String(r ?? "").trim() };
  }).filter((r) => r.id && r.text);
  if (sourceRequired.length === 0) return { ok: false, errors: ["source_required_changes empty/missing"] };
  if (expectedRequired.length) {
    const actual = new Map(sourceRequired.map((r) => [r.id, r.text]));
    const missingExpected = expectedRequired.filter((r) => actual.get(r.id) !== r.text).map((r) => r.id);
    const extraActual = sourceRequired.filter((r) => !expectedRequired.some((e) => e.id === r.id)).map((r) => r.id);
    if (missingExpected.length || extraActual.length) {
      return { ok: false, errors: [`source_required_changes mismatch; missing_or_changed=${missingExpected.join(",")}; extra=${extraActual.join(",")}`] };
    }
  }
  if (steps.length === 0) return { ok: false, errors: ["steps empty/missing"] };
  const addressed = new Set(steps.flatMap((s) => s.addresses));
  const missing = sourceRequired.filter((r) => !addressed.has(r.id)).map((r) => r.id);
  if (missing.length) return { ok: false, errors: [`required changes not addressed by any step: ${missing.join(",")}`] };
  return {
    ok: true,
    value: {
      plan_id: String(o.plan_id ?? "RP-1").trim(),
      source_decision: coerceEnum(o.source_decision, DECISION.filter((d) => d !== "accept"), "revise"),
      source_required_changes: sourceRequired,
      objectives: strList(o.objectives),
      steps,
      non_goals: strList(o.non_goals),
      assumptions: strList(o.assumptions),
      rollback: strList(o.rollback),
      verification_commands: strList(o.verification_commands),
      residual_risks: strList(o.residual_risks),
    },
    warnings,
  };
}

export function validateRepairPlanReviewResult(o, requiredChangeIds = []) {
  if (!o || typeof o !== "object") return { ok: false, errors: ["not an object"] };
  const purpose = String(o.review_purpose ?? "repair_plan_review").trim();
  const depth = Number(o.repair_depth ?? 1);
  if (purpose !== "repair_plan_review") return { ok: false, errors: [`invalid review_purpose: ${purpose}`] };
  if (depth !== 1) return { ok: false, errors: [`invalid repair_depth: ${depth}`] };
  const requiredIds = strList(requiredChangeIds);
  const coverage = asArray(o.coverage).map((c) => ({
    required_change: String(c?.required_change ?? "").trim(),
    status: coerceEnum(c?.status, COVERAGE_STATUS, "unverifiable"),
    evidence: String(c?.evidence ?? "").trim(),
  })).filter((c) => c.required_change);
  const covered = new Set(coverage.filter((c) => c.status === "addressed" || c.status === "partial").map((c) => c.required_change));
  const missing = requiredIds.filter((id) => !covered.has(id));
  const arb = validateArbitration(o.arbitration || {}).value;
  if (missing.length && arb.decision === "accept") {
    arb.decision = "revise";
    arb.risk_level = arb.risk_level === "low" ? "medium" : arb.risk_level;
    arb.required_changes = [...arb.required_changes, `Repair plan coverage missing or unverifiable for: ${missing.join(", ")}`];
    arb.arbiter_discovered_gaps = [...arb.arbiter_discovered_gaps, `repair_plan_review coverage guard downgraded accept because missing: ${missing.join(", ")}`];
  }
  return {
    ok: true,
    value: {
      repair_plan_id: String(o.repair_plan_id ?? "").trim(),
      review_purpose: purpose,
      repair_depth: depth,
      coverage,
      findings: asArray(o.findings),
      crossExam: o.crossExam,
      arbitration: arb,
      gaps: asArray(o.gaps),
    },
  };
}
// ============================ 通用工具 =======================================
export class TimeoutError extends Error {
  constructor(m) { super(m); this.name = "TimeoutError"; }
}
export function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise;
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new TimeoutError(`timeout after ${ms}ms`)), ms); });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(t)), timeout]);
}

// 并发信号量：最多 limit 个并行，结果按输入顺序返回；单项抛错降级为 gap（不中断整体）。
export async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let idx = 0;
  const n = Math.max(1, Math.min(limit || 1, items.length || 1));
  async function worker() {
    while (true) {
      const cur = idx++;
      if (cur >= items.length) return;
      try { ret[cur] = await fn(items[cur], cur); }
      catch (e) { ret[cur] = { ok: false, role: items[cur]?.name, gap: { kind: "error", detail: String(e?.message ?? e) } }; }
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  return ret;
}

// 配置：.opencode/adversarial-team.json（可选）覆盖内置默认。本机默认 glm-5/glm-5（无 anthropic）。
export async function loadConfig({ directory } = {}) {
  const env = (typeof process !== "undefined" && process.env) || {};
  const defaults = {
    defaultModel: { providerID: env.ADV_PROVIDER || "glm-5", modelID: env.ADV_MODEL || "glm-5" },
    roleModels: {},
    maxParallel: 4,            // V5 实测 6/6 可用，保守取 4
    perRoleTimeoutMs: 180000,
    maxRedispatchPerRole: 1,
    independentArbiter: "auto", // auto = minimal→false, standard/full→true（D6）
    debug: false,
    debugPromptLogDir: directory ? join(directory, ".opencode", "adversarial-team-log") : null,
  };
  if (!directory) return defaults;
  try {
    const cfg = JSON.parse(await readFile(join(directory, ".opencode", "adversarial-team.json"), "utf8"));
    return {
      ...defaults,
      ...cfg,
      defaultModel: cfg.defaultModel ?? defaults.defaultModel,
      roleModels: { ...defaults.roleModels, ...(cfg.roleModels || {}) },
    };
  } catch {
    return defaults;
  }
}

// lead 侧把 findings 串成紧凑文本喂给 cross-examiner / arbiter。
export function serializeFindings(findings) {
  return findings
    .map((f) => {
      const head = `### ${f.agent} (stance:${f.stance}${f.dimension ? `, dimension:${f.dimension}` : ""})\nsummary: ${f.summary}`;
      const claims = (f.claims || [])
        .map((c) => `- [${c.id}|${c.severity}|${c.confidence}] ${c.claim}${c.evidence ? ` (evidence: ${c.evidence})` : ""}`)
        .join("\n");
      const oq = f.open_questions?.length ? `\nopen_questions:\n${f.open_questions.map((q) => `- ${q}`).join("\n")}` : "";
      return `${head}\nclaims:\n${claims}${oq}`;
    })
    .join("\n\n");
}

const DEFAULT_PLAN_REVIEW_ROLES = [
  { name: "pro", stance: "pro" },
  { name: "con", stance: "con" },
  { name: "implementation-reviewer", stance: "dimension", dimension: "implementation" },
  { name: "risk-reviewer", stance: "dimension", dimension: "risk" },
  { name: "assumption-reviewer", stance: "dimension", dimension: "assumption" },
  { name: "test-reviewer", stance: "dimension", dimension: "test" },
];

function buildPlanReviewEvidence({ goal, evidence, constraints, initialPlan }) {
  return [
    "target_type: plan",
    "review_purpose: plan_loop_review",
    "plan_loop_depth: 1",
    "allow_plan_loop: false",
    "",
    `GOAL:\n${goal}`,
    constraints ? `\nCONSTRAINTS:\n${constraints}` : "",
    `\nSOURCE EVIDENCE:\n${evidence}`,
    `\nINITIAL PLAN:\n${JSON.stringify(initialPlan, null, 2)}`,
    "",
    "Review whether this plan is sufficient, feasible, testable, and unlikely to introduce new problems. Do not produce a new plan.",
  ].filter(Boolean).join("\n");
}
// ============================ 引擎工厂 =======================================
export function createEngine({ client, cfg }) {
  const C = { ...cfg };
  const log = (...a) => { if (C.debug) console.error("[adv-engine]", ...a); };
  let promptLogSeq = 0;

  const sid = (res) => res?.data?.id ?? res?.id ?? res?.info?.id ?? res?.data?.info?.id ?? null;
  const safeName = (s) => String(s || "unknown").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80);

  async function logPromptBody(id, kind, body) {
    if (!C.debug || !C.debugPromptLogDir) return;
    try {
      await mkdir(C.debugPromptLogDir, { recursive: true });
      const seq = String(++promptLogSeq).padStart(3, "0");
      const file = join(C.debugPromptLogDir, `${seq}-${safeName(id)}-${safeName(kind)}.json`);
      await writeFile(file, JSON.stringify({
        kind,
        sessionId: id,
        createdAt: new Date().toISOString(),
        body,
      }, null, 2), "utf8");
    } catch (e) {
      log("prompt debug logging failed", e?.message ?? e);
    }
  }

  function collectText(parts) {
    if (!Array.isArray(parts)) return "";
    return parts
      .filter((p) => p && p.type === "text" && typeof p.text === "string" && !p.ignored)
      .map((p) => p.text)
      .join("\n")
      .trim();
  }
  async function readReply(id, res) {
    const direct = collectText(res?.data?.parts ?? res?.parts);
    if (direct) return direct;
    // 兜底：从 messages 取最后一条 assistant
    try {
      const m = await client.session.messages({ path: { id } });
      const arr = m?.data ?? m ?? [];
      for (let k = arr.length - 1; k >= 0; k--) {
        const it = arr[k];
        const role = it?.info?.role ?? it?.role;
        if (role === "assistant") {
          const t = collectText(it?.parts);
          if (t) return t;
        }
      }
    } catch (e) { log("messages fallback failed", e?.message ?? e); }
    return direct || "";
  }

  async function createSession(title) {
    const r = await client.session.create({ body: { title } });
    const id = sid(r);
    if (!id) throw new Error("session.create returned no id: " + JSON.stringify(r).slice(0, 200));
    return id;
  }
  // 步骤2：noReply 注入角色身份（V2 PASS：累积生效）。不指定 model → 不触发生成，几乎零成本。
  async function injectRole(id, roleName) {
    const sys = ROLE_PROMPTS[roleName];
    if (!sys) throw new Error("unknown role: " + roleName);
    const body = { noReply: true, parts: [{ type: "text", text: `${SHARED_CONTRACT_C2}\n\n${sys}` }] };
    await logPromptBody(id, `inject-${roleName}`, body);
    await client.session.prompt({ path: { id }, body });
  }
  // 步骤3：给 evidence + 出 fenced findings。读 res.data.parts 文本（无 structured_output）。
  async function ask(id, model, text) {
    const body = { model, parts: [{ type: "text", text }] };
    await logPromptBody(id, "ask", body);
    const res = await client.session.prompt({ path: { id }, body });
    return readReply(id, res);
  }
  async function cleanup(id) {
    if (!id) return;
    try { await client.session.abort({ path: { id } }); } catch (e) { log("abort failed", e?.message ?? e); }
    try { await client.session.delete({ path: { id } }); } catch (e) { log("delete failed", e?.message ?? e); }
  }
  const modelFor = (role) => role.model ?? C.roleModels?.[role.name] ?? C.defaultModel;
  const maxRedispatch = Number.isFinite(Number(C.maxRedispatchPerRole)) ? Math.max(0, Number(C.maxRedispatchPerRole)) : 1;
  function isRedispatchableGap(gap) {
    if (!gap || gap.detail?.startsWith?.("unknown role:")) return false;
    return ["timeout", "empty", "schema_violation", "error"].includes(gap.kind);
  }
  async function runWithRedispatch({ role, phase, attempts, run }) {
    let result = await run();
    for (let attempt = 1; attempt <= maxRedispatch && !result?.ok && isRedispatchableGap(result.gap); attempt++) {
      const previous = result.gap || {};
      result = await run();
      attempts.push({
        role,
        phase,
        attempt,
        reason_kind: previous.kind || "error",
        reason_detail: String(previous.detail || "").slice(0, 200),
        success: Boolean(result?.ok),
      });
    }
    return result;
  }
  function buildRunStatus({ findings = [], crossExam, crossRequired = false, arbitration, arbiterRequired = false, gaps = [], redispatchAttempts = [] } = {}) {
    const completed = [];
    if (findings.length) completed.push("role_review");
    if (crossRequired && crossExam) completed.push("cross_examination");
    if (arbiterRequired && arbitration) completed.push("arbitration");
    let status = gaps.length ? "completed_with_gaps" : "completed";
    let incomplete_phase = null;
    let reason = gaps.length ? "Completed with recorded role or phase gaps." : "All required phases completed.";
    if (!findings.length) {
      status = "failed";
      incomplete_phase = "role_review";
      reason = "No reviewer findings were produced.";
    } else if (arbiterRequired && !arbitration) {
      status = "incomplete";
      incomplete_phase = "arbitration";
      reason = "Arbitration did not complete; no final decision is available.";
    } else if (crossRequired && !crossExam) {
      status = "incomplete";
      incomplete_phase = "cross_examination";
      reason = "Cross-examination did not complete; disputes were not fully sharpened.";
    }
    return {
      status,
      completed_phases: completed,
      incomplete_phase,
      reason,
      safe_to_use_decision: Boolean(arbitration) && status !== "failed" && status !== "incomplete",
      redispatch_attempts: redispatchAttempts,
      gaps_count: gaps.length,
    };
  }

  function tryParse(raw, validate) {
    if (!raw || !raw.trim()) return { ok: false, errors: ["empty reply"] };
    let obj;
    try { obj = parseStructured(raw).value; }
    catch (e) { return { ok: false, errors: ["parse: " + (e?.message ?? e)] }; }
    return validate(obj);
  }
  function tryParseFindings(raw, role) {
    return tryParse(raw, (o) => validateFindings(o, role));
  }
  // ask + 解析失败重试一次（对齐 workflow.md Robustness；reviewer/cross-examiner/arbiter 共用）。
  // 成功 → { ok:true, value }；失败 → { ok:false, kind:"empty"|"schema_violation", detail, raw }。
  async function askWithRetry(id, model, buildPrompt, parse, logName) {
    const raw = await withTimeout(ask(id, model, buildPrompt()), C.perRoleTimeoutMs);
    let parsed = parse(raw);
    if (parsed.ok) return { ok: true, value: parsed.value };
    log(`${logName} parse failed → retry`, parsed.errors);
    const raw2 = await withTimeout(ask(id, model, `${REPARSE_NUDGE}\n\n${buildPrompt()}`), C.perRoleTimeoutMs);
    parsed = parse(raw2);
    if (parsed.ok) return { ok: true, value: parsed.value };
    const empty = !raw2 || !raw2.trim();
    return { ok: false, kind: empty ? "empty" : "schema_violation", detail: (parsed.errors || []).join("; "), raw: String(raw2 || raw || "").slice(0, 400) };
  }

  async function runReviewer(role, evidence) {
    if (!ROLE_PROMPTS[role.name]) return { ok: false, role: role.name, gap: { kind: "error", detail: `unknown role: ${role.name}` } };
    let id;
    try {
      id = await createSession(`adv-${role.name}`);
      await injectRole(id, role.name);
      const r = await askWithRetry(
        id, modelFor(role),
        () => `EVIDENCE PACK:\n${evidence}\n\n${findingsInstruction(role)}`,
        (raw) => tryParseFindings(raw, role),
        role.name,
      );
      if (!r.ok) return { ok: false, role: role.name, gap: { kind: r.kind, detail: r.detail, raw: r.raw } };
      return { ok: true, finding: r.value };
    } catch (e) {
      return { ok: false, role: role.name, gap: { kind: e?.name === "TimeoutError" ? "timeout" : "error", detail: String(e?.message ?? e) } };
    } finally {
      await cleanup(id);
    }
  }

  async function runCrossExaminer(findings, evidence) {
    let id;
    try {
      id = await createSession("adv-cross-examiner");
      await injectRole(id, "cross-examiner");
      const r = await askWithRetry(
        id, modelFor({ name: "cross-examiner" }),
        () => `EVIDENCE PACK:\n${evidence}\n\nALL REVIEWER FINDINGS:\n${serializeFindings(findings)}\n\n${crossExamInstruction()}`,
        (raw) => tryParse(raw, validateCrossExam),
        "cross-examiner",
      );
      if (!r.ok) return { ok: false, gap: { role: "cross-examiner", kind: r.kind, detail: r.detail, raw: r.raw } };
      return { ok: true, value: r.value };
    } catch (e) {
      return { ok: false, gap: { role: "cross-examiner", kind: e?.name === "TimeoutError" ? "timeout" : "error", detail: String(e?.message ?? e) } };
    } finally {
      await cleanup(id);
    }
  }

  async function runArbiter(findings, crossExam) {
    let id;
    try {
      id = await createSession("adv-arbiter");
      await injectRole(id, "arbiter");
      const r = await askWithRetry(
        id, modelFor({ name: "arbiter" }),
        () => `REVIEWER FINDINGS:\n${serializeFindings(findings)}${crossExam ? `\n\nCROSS-EXAMINATION:\n${JSON.stringify(crossExam, null, 2)}` : ""}\n\n${arbitrationInstruction()}`,
        (raw) => tryParse(raw, validateArbitration),
        "arbiter",
      );
      if (!r.ok) return { ok: false, gap: { role: "arbiter", kind: r.kind, detail: r.detail, raw: r.raw } };
      return { ok: true, value: r.value };
    } catch (e) {
      return { ok: false, gap: { role: "arbiter", kind: e?.name === "TimeoutError" ? "timeout" : "error", detail: String(e?.message ?? e) } };
    } finally {
      await cleanup(id);
    }
  }

  async function runSolutionDesigner({ goal, evidence, constraints } = {}) {
    if (!goal || !evidence) throw new Error("runSolutionDesigner: goal 与 evidence 必填");
    let id;
    try {
      id = await createSession("adv-solution-designer");
      await injectRole(id, "solution-designer");
      const r = await askWithRetry(
        id,
        modelFor({ name: "solution-designer" }),
        () => `GOAL:\n${goal}${constraints ? `\n\nCONSTRAINTS:\n${constraints}` : ""}\n\nEVIDENCE PACK:\n${evidence}\n\n${initialPlanInstruction()}`,
        (raw) => tryParse(raw, validateInitialPlan),
        "solution-designer",
      );
      if (!r.ok) return { ok: false, gap: { role: "solution-designer", kind: r.kind, detail: r.detail, raw: r.raw } };
      return { ok: true, value: r.value };
    } catch (e) {
      return { ok: false, gap: { role: "solution-designer", kind: e?.name === "TimeoutError" ? "timeout" : "error", detail: String(e?.message ?? e) } };
    } finally {
      await cleanup(id);
    }
  }

  async function runPlanSynthesizer({ initialPlan, findings, crossExam, arbitration } = {}) {
    if (!initialPlan || !arbitration) throw new Error("runPlanSynthesizer: initialPlan 与 arbitration 必填");
    let id;
    try {
      id = await createSession("adv-plan-synthesizer");
      await injectRole(id, "plan-synthesizer");
      const r = await askWithRetry(
        id,
        modelFor({ name: "plan-synthesizer" }),
        () => `INITIAL PLAN:\n${JSON.stringify(initialPlan, null, 2)}\n\nREVIEWER FINDINGS:\n${serializeFindings(findings || [])}${crossExam ? `\n\nCROSS-EXAMINATION:\n${JSON.stringify(crossExam, null, 2)}` : ""}\n\nARBITRATION:\n${JSON.stringify(arbitration, null, 2)}\n\nplan_loop_depth: 1\nallow_plan_loop: false\n\n${acceptedPlanInstruction(initialPlan, arbitration)}`,
        (raw) => tryParse(raw, (o) => validateAcceptedPlan(o, initialPlan, arbitration)),
        "plan-synthesizer",
      );
      if (!r.ok) return { ok: false, gap: { role: "plan-synthesizer", kind: r.kind, detail: r.detail, raw: r.raw } };
      return { ok: true, value: r.value };
    } catch (e) {
      return { ok: false, gap: { role: "plan-synthesizer", kind: e?.name === "TimeoutError" ? "timeout" : "error", detail: String(e?.message ?? e) } };
    } finally {
      await cleanup(id);
    }
  }
  function repairPlanRequiredIds(repairPlan) {
    return asArray(repairPlan?.source_required_changes).map((r, idx) => String(r?.id ?? `RC${idx + 1}`).trim()).filter(Boolean);
  }

  function deriveRepairCoverage(repairPlan) {
    const requiredIds = repairPlanRequiredIds(repairPlan);
    const steps = asArray(repairPlan?.steps);
    return requiredIds.map((id) => {
      const matching = steps.filter((s) => strList(s?.addresses).includes(id));
      return {
        required_change: id,
        status: matching.length ? "addressed" : "missing",
        evidence: matching.length ? `Addressed by ${matching.map((s) => s.id || "unnamed-step").join(", ")}` : "No repair plan step references this required change.",
      };
    });
  }

  function buildRepairReviewEvidence({ repairPlan, evidence, findings, arbitration }) {
    return `target_type: plan
review_purpose: repair_plan_review
repair_depth: 1
allow_repair_planning: false
target_summary: Review whether the supplied remediation plan covers the original required changes without introducing new problems.
scope: repair plan only; do not change the original target decision
constraints: one bounded review pass; no repair-plan-of-repair-plan; planner output must stay separate from arbitration
success_criteria: every source_required_changes id is addressed and verifiable; validation and rollback are credible

ORIGINAL EVIDENCE PACK:
${evidence || ""}

ORIGINAL REVIEWER FINDINGS:
${findings?.length ? serializeFindings(findings) : "[]"}

ORIGINAL ARBITRATION:
${JSON.stringify(arbitration || {}, null, 2)}

REMEDIATION PLAN:
${JSON.stringify(repairPlan || {}, null, 2)}`;
  }

  async function runRepairPlanner({ evidence, findings = [], crossExam, arbitration, gaps = [] } = {}) {
    if (!arbitration || !Array.isArray(arbitration.required_changes) || arbitration.required_changes.length === 0) {
      const gap = { role: "repair-planner", kind: "error", detail: "arbitration.required_changes is required" };
      return {
        ok: false,
        gap,
        run_status: {
          status: "failed",
          completed_phases: [],
          incomplete_phase: "repair_planning",
          reason: "Repair planning cannot start without arbitration.required_changes.",
          safe_to_use_decision: false,
          redispatch_attempts: [],
          gaps_count: 1,
        },
      };
    }
    const redispatchAttempts = [];
    const sourceRequired = normalizeRequiredChanges(arbitration.required_changes);
    async function runPlannerOnce() {
      let id;
      try {
        id = await createSession("adv-repair-planner");
        await injectRole(id, "repair-planner");
        const r = await askWithRetry(
          id, modelFor({ name: "repair-planner" }),
          () => `ORIGINAL EVIDENCE PACK:
${evidence || ""}

ORIGINAL REVIEWER FINDINGS:
${findings?.length ? serializeFindings(findings) : "[]"}${crossExam ? `

ORIGINAL CROSS-EXAMINATION:
${JSON.stringify(crossExam, null, 2)}` : ""}

ORIGINAL ARBITRATION:
${JSON.stringify({ ...arbitration, source_required_changes: sourceRequired }, null, 2)}${gaps?.length ? `

ORIGINAL GAPS:
${JSON.stringify(gaps, null, 2)}` : ""}

${repairPlanInstruction()}`,
          (raw) => tryParse(raw, (o) => validateRepairPlan(o, sourceRequired)),
          "repair-planner",
        );
        if (!r.ok) return { ok: false, gap: { role: "repair-planner", kind: r.kind, detail: r.detail, raw: r.raw } };
        return { ok: true, repairPlan: r.value };
      } catch (e) {
        return { ok: false, gap: { role: "repair-planner", kind: e?.name === "TimeoutError" ? "timeout" : "error", detail: String(e?.message ?? e) } };
      } finally {
        await cleanup(id);
      }
    }
    const result = await runWithRedispatch({
      role: "repair-planner",
      phase: "repair_planning",
      attempts: redispatchAttempts,
      run: runPlannerOnce,
    });
    if (result.ok) {
      return {
        ...result,
        run_status: {
          status: "completed",
          completed_phases: ["repair_planning"],
          incomplete_phase: null,
          reason: "Repair plan produced.",
          safe_to_use_decision: false,
          redispatch_attempts: redispatchAttempts,
          gaps_count: 0,
        },
      };
    }
    return {
      ...result,
      run_status: {
        status: "failed",
        completed_phases: [],
        incomplete_phase: "repair_planning",
        reason: "Repair planner did not produce a valid remediation plan.",
        safe_to_use_decision: false,
        redispatch_attempts: redispatchAttempts,
        gaps_count: 1,
      },
    };
  }
  async function runRepairPlanArbiter({ repairPlan, coverage, findings, crossExam, arbitration }) {
    let id;
    try {
      id = await createSession("adv-repair-plan-arbiter");
      await injectRole(id, "arbiter");
      const r = await askWithRetry(
        id, modelFor({ name: "arbiter" }),
        () => `repair_plan_id: ${repairPlan?.plan_id || ""}
review_purpose: repair_plan_review
repair_depth: 1
allow_repair_planning: false

ORIGINAL TARGET ARBITRATION (do not change this decision):
${JSON.stringify(arbitration || {}, null, 2)}

REMEDIATION PLAN:
${JSON.stringify(repairPlan || {}, null, 2)}

REPAIR PLAN COVERAGE:
${JSON.stringify(coverage || [], null, 2)}

REPAIR PLAN REVIEWER FINDINGS:
${serializeFindings(findings || [])}${crossExam ? `

REPAIR PLAN CROSS-EXAMINATION:
${JSON.stringify(crossExam, null, 2)}` : ""}

${repairPlanReviewArbitrationInstruction()}`,
        (raw) => tryParse(raw, validateArbitration),
        "repair-plan-arbiter",
      );
      if (!r.ok) return { ok: false, gap: { role: "repair-plan-arbiter", kind: r.kind, detail: r.detail, raw: r.raw } };
      return { ok: true, value: r.value };
    } catch (e) {
      return { ok: false, gap: { role: "repair-plan-arbiter", kind: e?.name === "TimeoutError" ? "timeout" : "error", detail: String(e?.message ?? e) } };
    } finally {
      await cleanup(id);
    }
  }

  async function runRepairPlanReview({ repairPlan, evidence, findings = [], arbitration, roles, size = "standard", crossExam } = {}) {
    const expectedRequired = normalizeRequiredChanges(arbitration?.required_changes || []);
    const rp = validateRepairPlan(repairPlan, expectedRequired);
    if (!rp.ok) {
      const gaps = [{ role: "repair-plan-review", kind: "schema_violation", detail: rp.errors.join("; ") }];
      return {
        coverage: [],
        findings: [],
        gaps,
        run_status: {
          status: "failed",
          completed_phases: [],
          incomplete_phase: "repair_plan_validation",
          reason: "Repair plan schema validation failed before review fan-out.",
          safe_to_use_decision: false,
          redispatch_attempts: [],
          gaps_count: gaps.length,
        },
      };
    }
    const plan = rp.value;
    const defaultRepairReviewRoles = [
      { name: "pro", stance: "pro" },
      { name: "con", stance: "con" },
      { name: "implementation-reviewer", stance: "dimension", dimension: "implementation" },
      { name: "risk-reviewer", stance: "dimension", dimension: "risk" },
      { name: "test-reviewer", stance: "dimension", dimension: "test" },
    ];
    const requestedRoles = Array.isArray(roles) && roles.length ? roles : defaultRepairReviewRoles;
    const selectedRoles = requestedRoles.filter((r) => r?.name !== "repair-planner");
    if (selectedRoles.length === 0) selectedRoles.push(...defaultRepairReviewRoles);
    const reviewEvidence = buildRepairReviewEvidence({ repairPlan: plan, evidence, findings, arbitration });
    const redispatchAttempts = [];
    const results = await mapLimit(selectedRoles, C.maxParallel, (r) => runWithRedispatch({
      role: r.name,
      phase: "repair_plan_role_review",
      attempts: redispatchAttempts,
      run: () => runReviewer(r, reviewEvidence),
    }));
    const reviewFindings = results.filter((x) => x?.ok).map((x) => x.finding);
    const gaps = results.filter((x) => x && !x.ok).map((x) => ({ role: x.role, ...x.gap }));

    let cross;
    if ((crossExam ?? size === "full") && reviewFindings.length) {
      const cx = await runWithRedispatch({
        role: "cross-examiner",
        phase: "repair_plan_cross_examination",
        attempts: redispatchAttempts,
        run: () => runCrossExaminer(reviewFindings, reviewEvidence),
      });
      if (cx.ok) cross = cx.value; else gaps.push(cx.gap);
    }
    const coverage = deriveRepairCoverage(plan);
    let repairArbitration;
    if (reviewFindings.length) {
      const ar = await runWithRedispatch({
        role: "repair-plan-arbiter",
        phase: "repair_plan_arbitration",
        attempts: redispatchAttempts,
        run: () => runRepairPlanArbiter({ repairPlan: plan, coverage, findings: reviewFindings, crossExam: cross, arbitration }),
      });
      if (ar.ok) repairArbitration = ar.value; else gaps.push(ar.gap);
    }
    const checked = validateRepairPlanReviewResult({
      repair_plan_id: plan.plan_id,
      review_purpose: "repair_plan_review",
      repair_depth: 1,
      coverage,
      findings: reviewFindings,
      crossExam: cross,
      arbitration: repairArbitration,
      gaps,
    }, repairPlanRequiredIds(plan));
    return {
      ...checked.value,
      run_status: buildRunStatus({
        findings: reviewFindings,
        crossExam: cross,
        crossRequired: Boolean(crossExam ?? size === "full"),
        arbitration: repairArbitration,
        arbiterRequired: Boolean(reviewFindings.length),
        gaps,
        redispatchAttempts,
      }),
    };
  }
  // 核心编排：fan-out reviewers → (可选) cross-exam → (可选) 独立 arbiter。
  async function runReview({ evidence, roles, size = "standard", crossExam } = {}) {
    if (!evidence || !Array.isArray(roles) || roles.length === 0) {
      throw new Error("runReview: evidence(string) 与 非空 roles 必填");
    }
    const useCross = crossExam ?? size === "full";
    const useArb = C.independentArbiter === true || (C.independentArbiter === "auto" && size !== "minimal");

    const redispatchAttempts = [];
    const results = await mapLimit(roles, C.maxParallel, (r) => runWithRedispatch({
      role: r.name,
      phase: "role_review",
      attempts: redispatchAttempts,
      run: () => runReviewer(r, evidence),
    }));
    const findings = results.filter((x) => x?.ok).map((x) => x.finding);
    const gaps = results.filter((x) => x && !x.ok).map((x) => ({ role: x.role, ...x.gap }));

    let cross;
    if (useCross && findings.length) {
      const cx = await runWithRedispatch({
        role: "cross-examiner",
        phase: "cross_examination",
        attempts: redispatchAttempts,
        run: () => runCrossExaminer(findings, evidence),
      });
      if (cx.ok) cross = cx.value; else gaps.push(cx.gap);
    }
    let arbitration;
    if (useArb && findings.length) {
      const ar = await runWithRedispatch({
        role: "arbiter",
        phase: "arbitration",
        attempts: redispatchAttempts,
        run: () => runArbiter(findings, cross),
      });
      if (ar.ok) arbitration = ar.value; else gaps.push(ar.gap);
    }
    const run_status = buildRunStatus({ findings, crossExam: cross, crossRequired: useCross, arbitration, arbiterRequired: useArb, gaps, redispatchAttempts });
    return { findings, crossExam: cross, arbitration, gaps, run_status };
  }

  async function runPlanLoop({ goal, evidence, constraints, roles, size = "standard", crossExam } = {}) {
    if (!goal || !evidence) throw new Error("runPlanLoop: goal 与 evidence 必填");
    const gaps = [];
    const redispatchAttempts = [];
    const designed = await runWithRedispatch({
      role: "solution-designer",
      phase: "initial_planning",
      attempts: redispatchAttempts,
      run: () => runSolutionDesigner({ goal, evidence, constraints }),
    });
    if (!designed.ok) {
      return {
        initialPlan: null,
        review: { findings: [] },
        blocked_reason: "Solution designer did not return a valid InitialPlan.",
        plan_loop_depth: 1,
        allow_plan_loop: false,
        gaps: [designed.gap],
        run_status: {
          status: "failed",
          completed_phases: [],
          incomplete_phase: "initial_planning",
          reason: "No valid InitialPlan was produced.",
          safe_to_use_decision: false,
          redispatch_attempts: redispatchAttempts,
          gaps_count: 1,
        },
      };
    }

    const initialPlan = designed.value;
    const reviewRoles = Array.isArray(roles) && roles.length ? roles : DEFAULT_PLAN_REVIEW_ROLES;
    const planEvidence = buildPlanReviewEvidence({ goal, evidence, constraints, initialPlan });
    const review = await runReview({ evidence: planEvidence, roles: reviewRoles, size, crossExam });
    gaps.push(...(review.gaps || []));
    redispatchAttempts.push(...(review.run_status?.redispatch_attempts || []));

    let arbitration = review.arbitration;
    if (!arbitration && review.findings?.length) {
      const ar = await runWithRedispatch({
        role: "arbiter",
        phase: "plan_loop_arbitration",
        attempts: redispatchAttempts,
        run: () => runArbiter(review.findings, review.crossExam),
      });
      if (ar.ok) arbitration = ar.value; else gaps.push(ar.gap);
    }
    const normalizedReview = { findings: review.findings || [], crossExam: review.crossExam, arbitration };
    const completed = ["initial_planning"];
    if (normalizedReview.findings.length) completed.push("plan_review");
    if (normalizedReview.crossExam) completed.push("cross_examination");
    if (arbitration) completed.push("arbitration");

    if (!arbitration) {
      return {
        initialPlan,
        review: normalizedReview,
        blocked_reason: "Plan review did not produce arbitration; no accepted plan was synthesized.",
        plan_loop_depth: 1,
        allow_plan_loop: false,
        gaps,
        run_status: {
          status: "incomplete",
          completed_phases: completed,
          incomplete_phase: "arbitration",
          reason: "Plan Loop stopped before synthesis because arbitration is missing.",
          safe_to_use_decision: false,
          redispatch_attempts: redispatchAttempts,
          gaps_count: gaps.length,
        },
      };
    }
    if (arbitration.decision === "block") {
      return {
        initialPlan,
        review: normalizedReview,
        blocked_reason: arbitration.reasoning || "Arbiter blocked the initial plan.",
        plan_loop_depth: 1,
        allow_plan_loop: false,
        gaps,
        run_status: {
          status: gaps.length ? "completed_with_gaps" : "completed",
          completed_phases: completed,
          incomplete_phase: null,
          reason: "Plan Loop produced a blocked result; no AcceptedPlan was synthesized.",
          safe_to_use_decision: true,
          redispatch_attempts: redispatchAttempts,
          gaps_count: gaps.length,
        },
      };
    }
    if (arbitration.decision === "investigate") {
      return {
        initialPlan,
        review: normalizedReview,
        investigation_plan: arbitration.reasoning || "Arbiter requires more evidence before an accepted plan can be synthesized.",
        plan_loop_depth: 1,
        allow_plan_loop: false,
        gaps,
        run_status: {
          status: gaps.length ? "completed_with_gaps" : "completed",
          completed_phases: completed,
          incomplete_phase: null,
          reason: "Plan Loop produced an investigation result; no AcceptedPlan was synthesized.",
          safe_to_use_decision: true,
          redispatch_attempts: redispatchAttempts,
          gaps_count: gaps.length,
        },
      };
    }

    const synthesized = await runWithRedispatch({
      role: "plan-synthesizer",
      phase: "plan_synthesis",
      attempts: redispatchAttempts,
      run: () => runPlanSynthesizer({ initialPlan, findings: review.findings, crossExam: review.crossExam, arbitration }),
    });
    if (!synthesized.ok) {
      gaps.push(synthesized.gap);
      return {
        initialPlan,
        review: normalizedReview,
        blocked_reason: "Plan synthesizer did not return a valid AcceptedPlan.",
        plan_loop_depth: 1,
        allow_plan_loop: false,
        gaps,
        run_status: {
          status: "incomplete",
          completed_phases: completed,
          incomplete_phase: "plan_synthesis",
          reason: "Plan Loop stopped because synthesis failed validation.",
          safe_to_use_decision: false,
          redispatch_attempts: redispatchAttempts,
          gaps_count: gaps.length,
        },
      };
    }
    completed.push("plan_synthesis");
    const out = {
      initialPlan,
      review: normalizedReview,
      acceptedPlan: synthesized.value,
      plan_loop_depth: 1,
      allow_plan_loop: false,
      gaps,
    };
    const checked = validatePlanLoopResult(out);
    const run_status = {
      status: gaps.length ? "completed_with_gaps" : "completed",
      completed_phases: completed,
      incomplete_phase: null,
      reason: checked.ok ? "Plan Loop produced an AcceptedPlan." : "Plan Loop produced a plan that failed final schema validation.",
      safe_to_use_decision: checked.ok,
      redispatch_attempts: redispatchAttempts,
      gaps_count: gaps.length + (checked.ok ? 0 : 1),
    };
    if (checked.ok) return { ...checked.value, run_status };
    return { ...out, gaps: [...gaps, { role: "plan-loop", kind: "schema_violation", detail: checked.errors.join("; ") }], run_status };
  }
  return { runReview, runReviewer, runCrossExaminer, runArbiter, runSolutionDesigner, runPlanSynthesizer, runPlanLoop, runRepairPlanner, runRepairPlanReview, _internals: { sid, readReply, createSession, cleanup, modelFor } };
}
