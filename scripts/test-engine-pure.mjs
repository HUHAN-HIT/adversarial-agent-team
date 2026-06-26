// Offline 纯函数自检（无需 opencode server）：解析器 + 校验器。
// 用法: node scripts/test-engine-pure.mjs
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_ENUMS,
  parseStructured,
  parseYamlSubset,
  validateFindings,
  validateCrossExam,
  validateArbitration,
  validateInitialPlan,
  validateAcceptedPlan,
  validatePlanLoopResult,
  validateRepairPlan,
  validateRepairPlanReviewResult,
  ROLE_PROMPTS,
  createEngine,
} from "../assets/opencode/plugin/adversarial-engine.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("  ✗ FAIL:", msg); } };
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

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

// 5b) repair plan / repair-plan-review 校验：计划与二阶审查是独立 artifact，不塞进 arbitration。
{
  const rp = validateRepairPlan({
    plan_id: "RP-1",
    source_decision: "revise",
    source_required_changes: [{ id: "RC1", text: "Fix enumeration" }],
    objectives: ["Remove user enumeration"],
    steps: [{
      id: "STEP1",
      addresses: ["RC1", "S1"],
      action: "Return a uniform response for known and unknown email addresses.",
      files_or_interfaces: ["src/auth/reset.ts"],
      validation: ["Add tests for known and unknown email responses."],
      dependencies: [],
      risks: ["May affect clients relying on 404."]
    }],
    rollback: ["Revert endpoint response change if compatibility breaks."],
    verification_commands: ["npm test -- auth/reset"],
    residual_risks: ["External rate limiting still unverified."]
  });
  ok(rp.ok && rp.value.steps[0].addresses.includes("RC1"), "repair plan validates and preserves coverage refs");

  const yamlPlan = validateRepairPlan(parseStructured([
    "```yaml",
    "plan_id: RP-2",
    "source_decision: revise",
    "source_required_changes:",
    "  - id: RC1",
    "    text: Fix S1",
    "objectives:",
    "  - Fix S1 safely",
    "steps:",
    "  - id: STEP1",
    "    addresses: [RC1]",
    "    action: Fix S1",
    "    validation:",
    "      - npm test",
    "rollback:",
    "  - Revert STEP1",
    "verification_commands:",
    "  - npm test",
    "residual_risks: []",
    "```",
  ].join("\n")).value);
  ok(yamlPlan.ok && yamlPlan.value.steps[0].addresses.includes("RC1"), "repair plan YAML inline address list parses");

  const review = validateRepairPlanReviewResult({
    repair_plan_id: "RP-1",
    review_purpose: "repair_plan_review",
    repair_depth: 1,
    coverage: [{ required_change: "RC1", status: "addressed", evidence: "STEP1 addresses RC1" }],
    findings: [],
    arbitration: { decision: "accept", risk_level: "low", confidence: "high", reasoning: "covered" },
    gaps: []
  }, ["RC1"]);
  ok(review.ok && review.value.coverage[0].status === "addressed", "repair plan review validates addressed coverage");
  const incompletePlan = validateRepairPlan({
    plan_id: "RP-3",
    source_decision: "revise",
    source_required_changes: [{ id: "RC1", text: "Fix first issue" }],
    objectives: ["Fix only one issue"],
    steps: [{ id: "STEP1", addresses: ["RC1"], action: "Fix first issue", validation: ["npm test"] }],
    rollback: ["Revert STEP1"],
    verification_commands: ["npm test"],
    residual_risks: []
  }, [{ id: "RC1", text: "Fix first issue" }, { id: "RC2", text: "Fix second issue" }]);
  ok(!incompletePlan.ok, "repair plan must preserve every original required change");
  const uncoveredPlan = validateRepairPlan({
    plan_id: "RP-4",
    source_decision: "revise",
    source_required_changes: [{ id: "RC1", text: "Fix first issue" }, { id: "RC2", text: "Fix second issue" }],
    objectives: ["Fix both issues"],
    steps: [{ id: "STEP1", addresses: ["RC1"], action: "Fix first issue", validation: ["npm test"] }],
    rollback: ["Revert STEP1"],
    verification_commands: ["npm test"],
    residual_risks: []
  }, [{ id: "RC1", text: "Fix first issue" }, { id: "RC2", text: "Fix second issue" }]);
  ok(!uncoveredPlan.ok, "repair plan must map every original required change to a step");

  const invalidReview = validateRepairPlanReviewResult({
    repair_plan_id: "RP-1",
    review_purpose: "normal_review",
    repair_depth: 2,
    coverage: [{ required_change: "RC1", status: "addressed", evidence: "STEP1" }],
    arbitration: { decision: "accept", risk_level: "low", confidence: "high", reasoning: "wrong depth" },
  }, ["RC1"]);
  ok(!invalidReview.ok, "repair plan review result rejects wrong purpose/depth");

  const missing = validateRepairPlanReviewResult({
    repair_plan_id: "RP-1",
    review_purpose: "repair_plan_review",
    repair_depth: 1,
    coverage: [],
    arbitration: { decision: "accept", risk_level: "low", confidence: "high", reasoning: "incorrectly optimistic" },
  }, ["RC1"]);
  ok(missing.ok && missing.value.arbitration.decision !== "accept", "missing required-change coverage cannot remain accept");
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
    "feasibility-reviewer", "risk-reviewer", "impact-reviewer", "assumption-reviewer", "implementation-reviewer",
    "solution-designer", "plan-synthesizer", "repair-planner"];
  const missing = required.filter((r) => !ROLE_PROMPTS[r]);
  ok(missing.length === 0, `ROLE_PROMPTS missing: ${missing.join(",")}`);
  ok(!ROLE_PROMPTS.coordinator && !ROLE_PROMPTS.scribe, "coordinator/scribe NOT in ROLE_PROMPTS (D6/D8)");
}

// 8) Reference drift guards: docs and embedded runtime contracts must mention the same role/schema surface.
{
  const rolesDoc = await readFile(join(repoRoot, "references", "roles.md"), "utf8");
  const schemaDoc = await readFile(join(repoRoot, "references", "output-schema.md"), "utf8");
  const expectedRoles = Object.keys(ROLE_PROMPTS);
  const missingRoles = expectedRoles.filter((r) =>
    !rolesDoc.includes(r) &&
    !(r === "pro" && rolesDoc.includes("Pro Agent")) &&
    !(r === "con" && rolesDoc.includes("Con Agent")) &&
    !(r === "cross-examiner" && rolesDoc.includes("Cross-Examiner"))
  );
  ok(missingRoles.length === 0, `roles.md missing ROLE_PROMPTS entries: ${missingRoles.join(",")}`);
  for (const [name, values] of Object.entries(SCHEMA_ENUMS)) {
    const missing = values.filter((v) => !schemaDoc.includes(v));
    ok(missing.length === 0, `output-schema.md missing ${name} enum values: ${missing.join(",")}`);
  }
  ok(schemaDoc.includes("mode: A | B | C | C2 | D"), "output-schema evidence pack includes Mode C2");
  ok(schemaDoc.includes("run_status:"), "output-schema documents run_status envelope");
  ok(schemaDoc.includes("safe_to_use_decision:"), "output-schema documents unsafe incomplete decisions");
}

// 9) Debug prompt logging records prompts only and preserves reviewer-output isolation evidence.
{
  const tempDir = await mkdtemp(join(tmpdir(), "adv-engine-"));
  const logDir = join(tempDir, "logs");
  let sessionSeq = 0;
  const client = {
    session: {
      create: async () => ({ data: { id: `s${++sessionSeq}` } }),
      prompt: async ({ body }) => {
        if (body.noReply) return { data: { parts: [] } };
        const prompt = body.parts?.[0]?.text || "";
        const agent = prompt.includes("agent: con") ? "con" : "pro";
        const claim = agent === "con" ? "con-only-output-claim" : "pro-only-output-claim";
        return {
          data: {
            parts: [{
              type: "text",
              text: [
                "```yaml",
                `agent: ${agent}`,
                `stance: ${agent}`,
                `summary: ${agent} summary`,
                "claims:",
                "  - id: C1",
                `    claim: ${claim}`,
                "    evidence: mocked evidence",
                "    severity: low",
                "    confidence: high",
                "```",
              ].join("\n"),
            }],
          },
        };
      },
      messages: async () => ({ data: [] }),
      abort: async () => ({}),
      delete: async () => ({}),
    },
  };
  const engine = createEngine({
    client,
    cfg: {
      defaultModel: { providerID: "mock", modelID: "mock" },
      roleModels: {},
      maxParallel: 2,
      perRoleTimeoutMs: 1000,
      independentArbiter: false,
      debug: true,
      debugPromptLogDir: logDir,
    },
  });
  const out = await engine.runReview({
    evidence: "target_type: code\ntarget_summary: debug isolation check",
    roles: [{ name: "pro", stance: "pro" }, { name: "con", stance: "con" }],
    size: "minimal",
  });
  ok(out.findings.length === 2, "mock review produced two findings");
  const files = await readdir(logDir);
  const combined = (await Promise.all(files.map((f) => readFile(join(logDir, f), "utf8")))).join("\n");
  ok(files.length >= 4, `debug prompt log wrote inject+ask records (got ${files.length})`);
  ok(combined.includes("debug isolation check"), "debug prompt log contains evidence prompt");
  ok(!combined.includes("pro-only-output-claim") && !combined.includes("con-only-output-claim"), "debug prompt log excludes reviewer outputs");
  await rm(tempDir, { recursive: true, force: true });
}

// 10) Bounded redispatch: retry recoverable role failures in a fresh isolated session.
{
  const calls = [];
  let sessionSeq = 0;
  const askCountByTitle = new Map();
  const titlesById = new Map();
  const client = {
    session: {
      create: async ({ body }) => {
        const id = `rd${++sessionSeq}`;
        titlesById.set(id, body.title);
        calls.push(["create", body.title, id]);
        return { data: { id } };
      },
      prompt: async ({ path, body }) => {
        if (body.noReply) return { data: { parts: [] } };
        const title = titlesById.get(path.id);
        const n = (askCountByTitle.get(title) || 0) + 1;
        askCountByTitle.set(title, n);
        calls.push(["ask", title, path.id, n]);
        if (title === "adv-con" && n === 1) throw new Error("transient model failure");
        const agent = title === "adv-con" ? "con" : "pro";
        return {
          data: { parts: [{ type: "text", text: JSON.stringify({
            agent,
            stance: agent,
            summary: `${agent} recovered`,
            claims: [{ id: "C1", claim: `${agent} claim`, evidence: "mock", severity: "low", confidence: "high" }]
          }) }] }
        };
      },
      messages: async () => ({ data: [] }),
      abort: async () => ({}),
      delete: async () => ({}),
    },
  };
  const engine = createEngine({
    client,
    cfg: {
      defaultModel: { providerID: "mock", modelID: "mock" },
      roleModels: {},
      maxParallel: 1,
      perRoleTimeoutMs: 1000,
      maxRedispatchPerRole: 1,
      independentArbiter: false,
      debug: false,
    },
  });
  const out = await engine.runReview({
    evidence: "target_type: code\ntarget_summary: redispatch reviewer",
    roles: [{ name: "pro", stance: "pro" }, { name: "con", stance: "con" }],
    size: "minimal",
  });
  ok(out.findings.length === 2, "redispatch recovers a failed reviewer");
  ok(calls.filter((c) => c[0] === "create" && c[1] === "adv-con").length === 2, "redispatch creates a fresh session for the failed reviewer");
  ok(out.run_status?.redispatch_attempts?.some((a) => a.role === "con" && a.success === true), "run_status records successful redispatch attempt");
  ok(out.gaps.length === 0 && out.run_status?.status === "completed", "recovered redispatch does not leave stale gaps");
}

// 11) Incomplete run status: a failed arbiter must not be reported as a safe completed decision.
{
  let sessionSeq = 0;
  const titlesById = new Map();
  const client = {
    session: {
      create: async ({ body }) => {
        const id = `rs${++sessionSeq}`;
        titlesById.set(id, body.title);
        return { data: { id } };
      },
      prompt: async ({ path, body }) => {
        if (body.noReply) return { data: { parts: [] } };
        const title = titlesById.get(path.id);
        if (title === "adv-arbiter") throw new Error("arbiter unavailable");
        const agent = title === "adv-con" ? "con" : "pro";
        return {
          data: { parts: [{ type: "text", text: JSON.stringify({
            agent,
            stance: agent,
            summary: `${agent} summary`,
            claims: [{ id: "C1", claim: `${agent} claim`, evidence: "mock", severity: "low", confidence: "high" }]
          }) }] }
        };
      },
      messages: async () => ({ data: [] }),
      abort: async () => ({}),
      delete: async () => ({}),
    },
  };
  const engine = createEngine({
    client,
    cfg: {
      defaultModel: { providerID: "mock", modelID: "mock" },
      roleModels: {},
      maxParallel: 2,
      perRoleTimeoutMs: 1000,
      maxRedispatchPerRole: 0,
      independentArbiter: true,
      debug: false,
    },
  });
  const out = await engine.runReview({
    evidence: "target_type: code\ntarget_summary: arbiter failure",
    roles: [{ name: "pro", stance: "pro" }, { name: "con", stance: "con" }],
    size: "standard",
  });
  ok(!out.arbitration, "arbiter failure leaves arbitration absent");
  ok(out.run_status?.status === "incomplete", "arbiter failure marks the run incomplete");
  ok(out.run_status?.incomplete_phase === "arbitration", "run_status identifies arbitration as incomplete phase");
  ok(out.run_status?.safe_to_use_decision === false, "incomplete arbitration is not safe to use as a decision");
}
// 12) Repair planner lifecycle: planner is explicit and does not fan out reviewers.
{
  const calls = [];
  let sessionSeq = 0;
  const client = {
    session: {
      create: async ({ body }) => {
        calls.push(["create", body.title]);
        return { data: { id: `rp${++sessionSeq}` } };
      },
      prompt: async ({ path, body }) => {
        calls.push([body.noReply ? "inject" : "ask", path.id, body.parts?.[0]?.text || ""]);
        if (body.noReply) return { data: { parts: [] } };
        return {
          data: { parts: [{ type: "text", text: JSON.stringify({
            plan_id: "RP-1",
            source_decision: "revise",
            source_required_changes: [{ id: "RC1", text: "Fix S1" }],
            objectives: ["Fix S1 safely"],
            steps: [{ id: "STEP1", addresses: ["RC1"], action: "Fix S1", validation: ["Run focused test"] }],
            rollback: ["Revert STEP1"],
            verification_commands: ["npm test"],
            residual_risks: []
          }) }] }
        };
      },
      messages: async () => ({ data: [] }),
      abort: async () => ({}),
      delete: async () => ({}),
    },
  };
  const engine = createEngine({
    client,
    cfg: {
      defaultModel: { providerID: "mock", modelID: "mock" },
      roleModels: {},
      maxParallel: 2,
      perRoleTimeoutMs: 1000,
      independentArbiter: false,
      debug: false,
    },
  });
  const out = await engine.runRepairPlanner({
    evidence: "target_type: code",
    findings: [{ agent: "con", stance: "con", summary: "s", claims: [{ id: "C1", claim: "c", evidence: "e", severity: "high", confidence: "high" }] }],
    arbitration: { decision: "revise", risk_level: "high", confidence: "high", required_changes: ["Fix S1"], reasoning: "must fix" },
  });
  ok(out.ok && out.repairPlan.plan_id === "RP-1", "runRepairPlanner returns a repair plan");
  ok(calls.filter((c) => c[0] === "create").length === 1 && calls[0][1] === "adv-repair-planner", "runRepairPlanner creates only the planner session");
}

// 13) Repair planner redispatch: planner failure retries in a fresh session without reviewer fan-out.
{
  const calls = [];
  let sessionSeq = 0;
  let askCount = 0;
  const client = {
    session: {
      create: async ({ body }) => {
        calls.push(["create", body.title]);
        return { data: { id: `rpr${++sessionSeq}` } };
      },
      prompt: async ({ path, body }) => {
        calls.push([body.noReply ? "inject" : "ask", path.id, body.parts?.[0]?.text || ""]);
        if (body.noReply) return { data: { parts: [] } };
        askCount += 1;
        if (askCount === 1) throw new Error("planner transient failure");
        return {
          data: { parts: [{ type: "text", text: JSON.stringify({
            plan_id: "RP-1",
            source_decision: "revise",
            source_required_changes: [{ id: "RC1", text: "Fix S1" }],
            objectives: ["Fix S1 safely"],
            steps: [{ id: "STEP1", addresses: ["RC1"], action: "Fix S1", validation: ["Run focused test"] }],
            rollback: ["Revert STEP1"],
            verification_commands: ["npm test"],
            residual_risks: []
          }) }] }
        };
      },
      messages: async () => ({ data: [] }),
      abort: async () => ({}),
      delete: async () => ({}),
    },
  };
  const engine = createEngine({
    client,
    cfg: {
      defaultModel: { providerID: "mock", modelID: "mock" },
      roleModels: {},
      maxParallel: 2,
      perRoleTimeoutMs: 1000,
      maxRedispatchPerRole: 1,
      independentArbiter: false,
      debug: false,
    },
  });
  const out = await engine.runRepairPlanner({
    evidence: "target_type: code",
    findings: [{ agent: "con", stance: "con", summary: "s", claims: [{ id: "C1", claim: "c", evidence: "e", severity: "high", confidence: "high" }] }],
    arbitration: { decision: "revise", risk_level: "high", confidence: "high", required_changes: ["Fix S1"], reasoning: "must fix" },
  });
  ok(out.ok && out.repairPlan.plan_id === "RP-1", "runRepairPlanner redispatch recovers transient planner failure");
  ok(calls.filter((c) => c[0] === "create" && c[1] === "adv-repair-planner").length === 2, "runRepairPlanner redispatch creates a fresh planner session");
  ok(out.run_status?.redispatch_attempts?.some((a) => a.role === "repair-planner" && a.success === true), "planner redispatch is audited in run_status");
}
// 14) Repair plan review lifecycle: fan-out review + arbiter, no planner recursion.
{
  const tempDir = await mkdtemp(join(tmpdir(), "adv-repair-review-"));
  const logDir = join(tempDir, "logs");
  const calls = [];
  let sessionSeq = 0;
  const client = {
    session: {
      create: async ({ body }) => {
        calls.push(["create", body.title]);
        return { data: { id: `rr${++sessionSeq}` } };
      },
      prompt: async ({ path, body }) => {
        const prompt = body.parts?.[0]?.text || "";
        calls.push([body.noReply ? "inject" : "ask", path.id, prompt]);
        if (body.noReply) return { data: { parts: [] } };
        if (prompt.includes("repair_plan_id:")) {
          return { data: { parts: [{ type: "text", text: JSON.stringify({
            decision: "accept",
            risk_level: "low",
            confidence: "high",
            required_changes: [],
            optional_improvements: [],
            residual_risks: [],
            arbiter_discovered_gaps: [],
            reasoning: "Repair plan covers RC1. This does not change the original target decision."
          }) }] } };
        }
        const agent = prompt.includes("agent: con") ? "con" : prompt.includes("agent: implementation-reviewer") ? "implementation-reviewer" : "pro";
        const stance = agent === "implementation-reviewer" ? "dimension" : agent;
        return { data: { parts: [{ type: "text", text: JSON.stringify({
          agent,
          stance,
          dimension: stance === "dimension" ? "implementation" : undefined,
          summary: `${agent} summary`,
          claims: [{ id: "C1", claim: `${agent}-repair-review-claim`, evidence: "repair plan RC1", severity: "low", confidence: "high" }]
        }) }] } };
      },
      messages: async () => ({ data: [] }),
      abort: async () => ({}),
      delete: async () => ({}),
    },
  };
  const engine = createEngine({
    client,
    cfg: {
      defaultModel: { providerID: "mock", modelID: "mock" },
      roleModels: {},
      maxParallel: 3,
      perRoleTimeoutMs: 1000,
      independentArbiter: "auto",
      debug: true,
      debugPromptLogDir: logDir,
    },
  });
  const repairPlan = {
    plan_id: "RP-1",
    source_decision: "revise",
    source_required_changes: [{ id: "RC1", text: "Fix S1" }],
    objectives: ["Fix S1 safely"],
    steps: [{ id: "STEP1", addresses: ["RC1"], action: "Fix S1", validation: ["Run focused test"] }],
    rollback: ["Revert STEP1"],
    verification_commands: ["npm test"],
    residual_risks: []
  };
  const out = await engine.runRepairPlanReview({
    repairPlan,
    evidence: "target_type: code\nreviewed-output-should-not-leak",
    findings: [],
    arbitration: { decision: "revise", risk_level: "high", confidence: "high", required_changes: ["Fix S1"], reasoning: "must fix" },
    roles: [{ name: "pro", stance: "pro" }, { name: "con", stance: "con" }, { name: "implementation-reviewer", stance: "dimension", dimension: "implementation" }, { name: "repair-planner", stance: "dimension", dimension: "repair" }],
    size: "standard",
  });
  ok(out.findings.length === 3 && out.arbitration?.decision === "accept", "runRepairPlanReview fans out reviewers and arbitrates the plan");
  ok(out.coverage[0]?.required_change === "RC1" && out.coverage[0].status === "addressed", "runRepairPlanReview derives required-change coverage");
  ok(!calls.some((c) => c[1] === "adv-repair-planner"), "runRepairPlanReview does not call repair planner");
  ok(out.run_status?.status === "completed" && out.run_status.safe_to_use_decision === true, "runRepairPlanReview returns a completed safe run_status");
  const omittedRequired = await engine.runRepairPlanReview({
    repairPlan,
    evidence: "target_type: code",
    findings: [],
    arbitration: { decision: "revise", risk_level: "high", confidence: "high", required_changes: ["Fix S1", "Fix S2"], reasoning: "must fix both" },
    roles: [{ name: "pro", stance: "pro" }],
    size: "standard",
  });
  ok(omittedRequired.gaps?.some((g) => g.kind === "schema_violation"), "runRepairPlanReview rejects a plan missing an original required change");
  const files = await readdir(logDir);
  const reviewerFiles = files.filter((f) => f.includes("-rr1-") || f.includes("-rr2-") || f.includes("-rr3-"));
  const combined = (await Promise.all(reviewerFiles.map((f) => readFile(join(logDir, f), "utf8")))).join("\n");
  ok(combined.includes("allow_repair_planning: false") && combined.includes("repair_depth: 1"), "repair reviewer prompts carry recursion guard");
  ok(combined.includes("Fix S1"), "repair reviewer prompts include original required changes");
  ok(!combined.includes("pro-repair-review-claim") && !combined.includes("con-repair-review-claim"), "repair reviewer prompt logs exclude other reviewer outputs");
  await rm(tempDir, { recursive: true, force: true });
}

// 17) Plan Loop schema: InitialPlan, AcceptedPlan, and blocked result stay explicit and bounded.
{
  const initial = validateInitialPlan({
    plan_id: "IP1",
    goal: "Add retry-safe dispatch",
    assumptions: ["existing queue contract stays stable"],
    steps: [{ id: "S1", action: "Add idempotency key", rationale: "prevents duplicate writes" }],
    validation: ["unit test duplicate delivery"],
    risks: ["migration may expose old rows"],
    open_questions: ["Which queues are in scope?"],
  });
  ok(initial.ok && initial.value.plan_id === "IP1", "InitialPlan validates");

  const accepted = validateAcceptedPlan({
    plan_id: "AP1",
    source_initial_plan_id: "IP1",
    source_decision: "revise",
    decision_preserved: true,
    changes_applied: [{ required_change_id: "RC1", change: "Add rollback step" }],
    final_steps: [{ id: "S1", action: "Add idempotency key" }],
    verification_commands: ["npm test"],
    residual_risks: ["legacy rows still need audit"],
  }, initial.value, { decision: "revise", required_changes: ["Add rollback step"] });
  ok(accepted.ok && accepted.value.decision_preserved === true, "AcceptedPlan validates after required changes");

  const blocked = validatePlanLoopResult({
    initialPlan: initial.value,
    review: { findings: [], arbitration: { decision: "block", required_changes: ["Need production schema"] } },
    blocked_reason: "Missing production schema evidence",
    plan_loop_depth: 1,
    allow_plan_loop: false,
    gaps: [],
  });
  ok(blocked.ok && !blocked.value.acceptedPlan, "PlanLoopResult supports blocked path without acceptedPlan");

  const bad = validatePlanLoopResult({
    initialPlan: initial.value,
    review: { findings: [], arbitration: { decision: "block", required_changes: ["Need production schema"] } },
    acceptedPlan: accepted.value,
    plan_loop_depth: 1,
    allow_plan_loop: false,
    gaps: [],
  });
  ok(!bad.ok, "PlanLoopResult rejects acceptedPlan when review decision is block");
}

// 18) Plan Loop runtime: design -> plan review -> arbitration -> synthesis, while block skips synthesis.
{
  const sessions = [];
  const prompts = [];
  const replies = {
    "adv-solution-designer": JSON.stringify({
      plan_id: "IP1",
      goal: "Ship safe change",
      assumptions: ["repo is writable"],
      steps: [{ id: "S1", action: "Patch code" }],
      validation: ["npm test"],
      risks: ["regression"],
      open_questions: [],
    }),
    "adv-pro": JSON.stringify({
      agent: "pro",
      stance: "pro",
      summary: "Plan is feasible.",
      claims: [{ id: "C1", claim: "Steps are clear", evidence: "InitialPlan S1", severity: "low", confidence: "high" }],
    }),
    "adv-con": JSON.stringify({
      agent: "con",
      stance: "con",
      summary: "Rollback is missing.",
      claims: [{ id: "C1", claim: "No rollback", evidence: "InitialPlan lacks rollback", severity: "medium", confidence: "high" }],
    }),
    "adv-arbiter": JSON.stringify({
      decision: "revise",
      risk_level: "medium",
      confidence: "high",
      required_changes: ["Add rollback"],
      optional_improvements: [],
      residual_risks: [],
      arbiter_discovered_gaps: [],
      reasoning: "A small revision is required.",
    }),
    "adv-plan-synthesizer": JSON.stringify({
      plan_id: "AP1",
      source_initial_plan_id: "IP1",
      source_decision: "revise",
      decision_preserved: true,
      changes_applied: [{ required_change_id: "RC1", change: "Add rollback" }],
      final_steps: [{ id: "S1", action: "Patch code" }, { id: "S2", action: "Rollback if tests fail" }],
      verification_commands: ["npm test"],
      residual_risks: [],
    }),
  };
  const client = {
    session: {
      async create({ body }) { sessions.push(body.title); return { data: { id: body.title } }; },
      async prompt({ path, body }) {
        prompts.push({ id: path.id, body });
        if (body.noReply) return { data: { parts: [] } };
        return { data: { parts: [{ type: "text", text: replies[path.id] }] } };
      },
      async messages() { return { data: [] }; },
      async abort() {},
      async delete() {},
    },
  };
  const engine = createEngine({ client, cfg: { defaultModel: { providerID: "test", modelID: "test" }, roleModels: {}, maxParallel: 2, perRoleTimeoutMs: 0, maxRedispatchPerRole: 0, independentArbiter: true } });
  const out = await engine.runPlanLoop({
    goal: "Ship safe change",
    evidence: "diff -- code",
    roles: [{ name: "pro", stance: "pro" }, { name: "con", stance: "con" }],
    size: "standard",
    crossExam: false,
  });
  ok(out.acceptedPlan?.plan_id === "AP1", "runPlanLoop returns acceptedPlan on revise path");
  ok(sessions.includes("adv-solution-designer") && sessions.includes("adv-plan-synthesizer"), "runPlanLoop uses designer and synthesizer sessions");
  const proPrompt = prompts.find((p) => p.id === "adv-pro" && !p.body.noReply)?.body.parts[0].text || "";
  ok(proPrompt.includes("plan_loop_depth: 1") && proPrompt.includes("allow_plan_loop: false"), "reviewer prompt carries bounded loop guard");
  ok(proPrompt.includes("INITIAL PLAN") && !proPrompt.includes("Rollback is missing"), "reviewer sees plan but not peer outputs");
  ok(out.run_status?.completed_phases?.includes("plan_synthesis"), "runPlanLoop run_status records synthesis completion");
}

{
  const sessions = [];
  const replies = {
    "adv-solution-designer": JSON.stringify({
      plan_id: "IP2",
      goal: "Migrate database",
      assumptions: [],
      steps: [{ id: "S1", action: "Run migration" }],
      validation: ["npm test"],
      risks: ["data loss"],
      open_questions: [],
    }),
    "adv-con": JSON.stringify({
      agent: "con",
      stance: "con",
      summary: "Evidence is missing.",
      claims: [{ id: "C1", claim: "No schema evidence", evidence: "Evidence pack omits schema", severity: "blocker", confidence: "high" }],
    }),
    "adv-arbiter": JSON.stringify({
      decision: "block",
      risk_level: "critical",
      confidence: "high",
      required_changes: ["Provide production schema"],
      optional_improvements: [],
      residual_risks: [],
      arbiter_discovered_gaps: [],
      reasoning: "Cannot produce an accepted plan without schema evidence.",
    }),
  };
  const client = {
    session: {
      async create({ body }) { sessions.push(body.title); return { data: { id: body.title } }; },
      async prompt({ path, body }) {
        if (body.noReply) return { data: { parts: [] } };
        return { data: { parts: [{ type: "text", text: replies[path.id] }] } };
      },
      async messages() { return { data: [] }; },
      async abort() {},
      async delete() {},
    },
  };
  const engine = createEngine({ client, cfg: { defaultModel: { providerID: "test", modelID: "test" }, roleModels: {}, maxParallel: 1, perRoleTimeoutMs: 0, maxRedispatchPerRole: 0, independentArbiter: true } });
  const out = await engine.runPlanLoop({
    goal: "Migrate database",
    evidence: "missing schema",
    roles: [{ name: "con", stance: "con" }],
    size: "standard",
    crossExam: false,
  });
  ok(out.blocked_reason && !out.acceptedPlan, "runPlanLoop returns blocked reason without acceptedPlan on block");
  ok(!sessions.includes("adv-plan-synthesizer"), "runPlanLoop does not synthesize after block");
}
console.log(`\n=== engine pure self-test: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
