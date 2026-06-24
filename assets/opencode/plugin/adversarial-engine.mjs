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

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ============================ 枚举（对接 output-schema.md）====================
const SEVERITY = ["blocker", "high", "medium", "low", "note"];
const CONFIDENCE = ["high", "medium", "low"];
const STANCE = ["pro", "con", "dimension"];
const DECISION = ["accept", "accept_with_conditions", "revise", "block", "investigate"];
const RISK = ["critical", "high", "medium", "low"];

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
    independentArbiter: "auto", // auto = minimal→false, standard/full→true（D6）
    debug: false,
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

// ============================ 引擎工厂 =======================================
export function createEngine({ client, cfg }) {
  const C = { ...cfg };
  const log = (...a) => { if (C.debug) console.error("[adv-engine]", ...a); };

  const sid = (res) => res?.data?.id ?? res?.id ?? res?.info?.id ?? res?.data?.info?.id ?? null;

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
    await client.session.prompt({
      path: { id },
      body: { noReply: true, parts: [{ type: "text", text: `${SHARED_CONTRACT_C2}\n\n${sys}` }] },
    });
  }
  // 步骤3：给 evidence + 出 fenced findings。读 res.data.parts 文本（无 structured_output）。
  async function ask(id, model, text) {
    const res = await client.session.prompt({ path: { id }, body: { model, parts: [{ type: "text", text }] } });
    return readReply(id, res);
  }
  async function cleanup(id) {
    if (!id) return;
    try { await client.session.abort({ path: { id } }); } catch (e) { log("abort failed", e?.message ?? e); }
    try { await client.session.delete({ path: { id } }); } catch (e) { log("delete failed", e?.message ?? e); }
  }
  const modelFor = (role) => role.model ?? C.roleModels?.[role.name] ?? C.defaultModel;

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

  // 核心编排：fan-out reviewers → (可选) cross-exam → (可选) 独立 arbiter。
  async function runReview({ evidence, roles, size = "standard", crossExam } = {}) {
    if (!evidence || !Array.isArray(roles) || roles.length === 0) {
      throw new Error("runReview: evidence(string) 与 非空 roles 必填");
    }
    const useCross = crossExam ?? size === "full";
    const useArb = C.independentArbiter === true || (C.independentArbiter === "auto" && size !== "minimal");

    const results = await mapLimit(roles, C.maxParallel, (r) => runReviewer(r, evidence));
    const findings = results.filter((x) => x?.ok).map((x) => x.finding);
    const gaps = results.filter((x) => x && !x.ok).map((x) => ({ role: x.role, ...x.gap }));

    let cross;
    if (useCross && findings.length) {
      const cx = await runCrossExaminer(findings, evidence);
      if (cx.ok) cross = cx.value; else gaps.push(cx.gap);
    }
    let arbitration;
    if (useArb && findings.length) {
      const ar = await runArbiter(findings, cross);
      if (ar.ok) arbitration = ar.value; else gaps.push(ar.gap);
    }
    return { findings, crossExam: cross, arbitration, gaps };
  }

  return { runReview, runReviewer, runCrossExaminer, runArbiter, _internals: { sid, readReply, createSession, cleanup, modelFor } };
}
