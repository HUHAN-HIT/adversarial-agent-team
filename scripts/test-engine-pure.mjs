// Offline 纯函数自检（无需 opencode server）：解析器 + 校验器。
// 用法: node scripts/test-engine-pure.mjs
import {
  parseStructured,
  parseYamlSubset,
  validateFindings,
  validateCrossExam,
  validateArbitration,
  ROLE_PROMPTS,
} from "../assets/opencode/plugin/adversarial-engine.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("  ✗ FAIL:", msg); } };

// 1) JSON 块（fenced ```json）
{
  const text = 'noise before\n```json\n{"agent":"pro","stance":"pro","summary":"ok","claims":[{"id":"C1","claim":"good","evidence":"e","severity":"low","confidence":"high"}]}\n```\ntrailing';
  const { value, via } = parseStructured(text);
  ok(via === "json", "JSON block parsed via json");
  const v = validateFindings(value, { name: "pro", stance: "pro" });
  ok(v.ok && v.value.claims.length === 1, "JSON findings validate");
}

// 2) YAML 块（claims = list-of-maps，open_questions = list-of-scalars，枚举大小写漂移）
{
  const text = [
    "```yaml",
    "agent: con",
    "stance: con",
    "summary: The change has gaps and risks.",
    "claims:",
    "  - id: C1",
    "    claim: Missing null check on input",
    "    evidence: line 42 dereferences user.name",
    "    severity: HIGH",
    "    confidence: medium",
    "    recommended_action: add a guard",
    "  - id: C2",
    "    claim: No test for the error path",
    "    evidence: tests cover only happy path",
    "    severity: medium",
    "    confidence: low",
    "open_questions:",
    "  - Is the input ever trusted?",
    "  - What about concurrent writers?",
    "```",
  ].join("\n");
  const { value, via } = parseStructured(text);
  ok(via === "yaml", "YAML block parsed via yaml (not json)");
  ok(Array.isArray(value.claims) && value.claims.length === 2, `YAML claims length == 2 (got ${value.claims?.length})`);
  ok(value.claims[0].claim === "Missing null check on input", "YAML claim text intact");
  ok(value.open_questions.length === 2, "YAML open_questions length == 2");
  const v = validateFindings(value, { name: "con", stance: "con" });
  ok(v.ok, "YAML findings validate ok");
  ok(v.value.claims[0].severity === "high", `severity HIGH coerced to high (got ${v.value.claims[0].severity})`);
  ok(v.value.agent === "con" && v.value.stance === "con", "role overrides agent/stance");
}

// 3) 维度 reviewer：dimension 字段从 role 注入
{
  const text = "```yaml\nagent: x\nstance: dimension\nsummary: s\nclaims:\n  - id: C1\n    claim: c\n    evidence: e\n    severity: blocker\n    confidence: high\n```";
  const v = validateFindings(parseStructured(text).value, { name: "security-reviewer", stance: "dimension", dimension: "security" });
  ok(v.ok && v.value.dimension === "security", "dimension injected from role");
  ok(v.value.agent === "security-reviewer", "agent = role name");
}

// 4) 坏枚举 + 缺 claims → 硬失败
{
  const v1 = validateFindings({ agent: "pro", stance: "pro", summary: "s", claims: [] }, { name: "pro", stance: "pro" });
  ok(!v1.ok, "empty claims → hard fail");
  const v2 = validateFindings({ summary: "s", claims: [{ id: "C1", claim: "c", evidence: "e", severity: "zzz", confidence: "qqq" }] }, { name: "pro", stance: "pro" });
  ok(v2.ok && v2.value.claims[0].severity === "note" && v2.value.claims[0].confidence === "low", "bad enums coerce to note/low");
}

// 5) cross-exam / arbitration 校验
{
  const cx = validateCrossExam({ disputed_points: ["pro C1 vs con C2"], questions_for_arbiter: "single becomes list" });
  ok(cx.ok && cx.value.disputed_points.length === 1 && cx.value.questions_for_arbiter.length === 1, "cross-exam normalizes");
  const ar = validateArbitration({ decision: "BLOCK", risk_level: "high", confidence: "medium", reasoning: "one blocker", required_changes: ["fix C1"] });
  ok(ar.ok && ar.value.decision === "block" && ar.value.required_changes.length === 1, "arbitration normalizes decision");
}

// 6) 无 fence 的裸 JSON 也能解析
{
  const { value } = parseStructured('{"agent":"pro","stance":"pro","summary":"s","claims":[{"id":"C1","claim":"c","evidence":"e","severity":"low","confidence":"low"}]}');
  ok(value.claims.length === 1, "bare JSON (no fence) parses");
}

// 7) ROLE_PROMPTS 覆盖 D7 要求的全部短名
{
  const required = ["pro", "con", "cross-examiner", "arbiter",
    "correctness-reviewer", "security-reviewer", "test-reviewer", "architecture-reviewer",
    "performance-reviewer", "ops-reviewer", "ux-api-reviewer",
    "feasibility-reviewer", "risk-reviewer", "impact-reviewer", "assumption-reviewer", "implementation-reviewer"];
  const missing = required.filter((r) => !ROLE_PROMPTS[r]);
  ok(missing.length === 0, `ROLE_PROMPTS missing: ${missing.join(",")}`);
  ok(!ROLE_PROMPTS.coordinator && !ROLE_PROMPTS.scribe, "coordinator/scribe NOT in ROLE_PROMPTS (D6/D8)");
}

console.log(`\n=== engine pure self-test: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
