#!/usr/bin/env node
// run-minimal-review.mjs
// ---------------------------------------------------------------------------
// M1 验收 harness（非侵入）：直接 import 引擎，对一段小 diff 跑 Minimal(pro+con) 评审，
// 连本机 opencode server，打印结构化 findings + gaps；再起一个独立 arbiter 演示
// 「lead 据 findings 仲裁」。不碰全局 opencode 配置、不依赖 plugin host。
//
// 用法:
//   1. opencode serve   （记下端口，默认 http://127.0.0.1:4096）
//   2. OPENCODE_BASE_URL=http://127.0.0.1:<port> \
//      ADV_PROVIDER=glm-5 ADV_MODEL=glm-5 node scripts/run-minimal-review.mjs
//
// 退出码: 0 = 验收通过（≥2 合法 findings，pro+con 各至少 1 条 claim）/ 1 = 未通过
// ---------------------------------------------------------------------------

import { createOpencodeClient } from "@opencode-ai/sdk";
import { createEngine } from "../assets/opencode/plugin/adversarial-engine.mjs";

const baseUrl = process.env.OPENCODE_BASE_URL || "http://127.0.0.1:4096";
const model = { providerID: process.env.ADV_PROVIDER || "glm-5", modelID: process.env.ADV_MODEL || "glm-5" };

// 小而真实的 evidence pack（含明显可争论点：无校验/边界/无测试）。
const evidence = `target_type: code
target_summary: A helper discountedPrice(price, pct) added to checkout, plus one call site.
scope: single function + its one call site
constraints: must not crash on coupon edge cases; keep it a pure function
success_criteria: correct price math for valid inputs; safe on edge inputs
evidence:
  diff: |
    + // pct is expected to be 0..100
    + function discountedPrice(price, pct) {
    +   return price - price * pct / 100;
    + }
    + // call site in checkout:
    + const final = discountedPrice(cart.total, coupon.percent);
  tests: none added
known_unknowns: coupon.percent may be undefined or > 100; cart.total may be negative or non-numeric`;

const roles = [
  { name: "pro", stance: "pro" },
  { name: "con", stance: "con" },
];

function printFinding(f) {
  console.log(`\n— [${f.agent}] stance=${f.stance}${f.dimension ? ` dim=${f.dimension}` : ""}`);
  console.log(`  summary: ${f.summary}`);
  for (const c of f.claims) {
    console.log(`  • ${c.id} [${c.severity}/${c.confidence}] ${c.claim}`);
    if (c.evidence) console.log(`      evidence: ${c.evidence}`);
    if (c.recommended_action) console.log(`      action: ${c.recommended_action}`);
  }
  if (f.open_questions?.length) console.log(`  open_questions: ${f.open_questions.join(" | ")}`);
}

async function main() {
  console.log(`# Minimal review harness`);
  console.log(`  server : ${baseUrl}`);
  console.log(`  model  : ${model.providerID}/${model.modelID}`);

  const client = createOpencodeClient({ baseUrl });

  // 连通性预检：列 sessions（轻量、只读）
  try {
    await client.session.list();
  } catch (e) {
    console.error(`\n✗ 无法连接 opencode server（${baseUrl}）。先跑 \`opencode serve\`。\n  ${e?.message ?? e}`);
    process.exit(2);
  }

  const cfg = {
    defaultModel: model,
    roleModels: {},
    maxParallel: 2,
    perRoleTimeoutMs: Number(process.env.ADV_TIMEOUT_MS || 240000),
    independentArbiter: "auto", // minimal → false（lead 自仲裁）
    debug: process.env.ADV_DEBUG === "1",
  };
  const engine = createEngine({ client, cfg });

  const t0 = Date.now ? Date.now() : 0; // Date.now 在 harness（非 workflow）下可用
  console.log(`\n## fan-out Minimal (pro + con) ...`);
  const out = await engine.runReview({ evidence, roles, size: "minimal" });
  const elapsed = Date.now ? ((Date.now() - t0) / 1000).toFixed(1) : "?";

  console.log(`\n## findings (${out.findings.length}) — ${elapsed}s`);
  out.findings.forEach(printFinding);

  if (out.gaps.length) {
    console.log(`\n## gaps (${out.gaps.length})`);
    for (const g of out.gaps) console.log(`  ! ${g.role}: ${g.kind} — ${g.detail}`);
  }

  // 验收判定：≥2 findings，pro 与 con 各至少 1 条 claim。
  const byStance = Object.fromEntries(out.findings.map((f) => [f.stance, f]));
  const pass =
    out.findings.length >= 2 &&
    byStance.pro?.claims?.length >= 1 &&
    byStance.con?.claims?.length >= 1;

  // 演示「lead 据 findings 仲裁」：Minimal 下 independentArbiter=false，这里显式起一个
  // arbiter session 证明结构化 findings 足以支撑仲裁（never average）。
  let arb;
  if (out.findings.length) {
    console.log(`\n## demo: independent arbiter over the Minimal findings ...`);
    const r = await engine.runArbiter(out.findings, out.crossExam);
    if (r.ok) {
      arb = r.value;
      console.log(`  decision: ${arb.decision} | risk: ${arb.risk_level} | confidence: ${arb.confidence}`);
      if (arb.required_changes.length) console.log(`  required_changes: ${arb.required_changes.join(" | ")}`);
      if (arb.residual_risks.length) console.log(`  residual_risks: ${arb.residual_risks.join(" | ")}`);
      console.log(`  reasoning: ${arb.reasoning}`);
    } else {
      console.log(`  ! arbiter gap: ${r.gap.kind} — ${r.gap.detail}`);
    }
  }

  console.log(`\n=== 验收: ${pass ? "PASS ✅" : "FAIL ❌"} (findings=${out.findings.length}, pro_claims=${byStance.pro?.claims?.length ?? 0}, con_claims=${byStance.con?.claims?.length ?? 0}, arbitration=${arb ? "yes" : "no"}) ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("harness crashed:", e?.stack ?? e);
  process.exit(3);
});
