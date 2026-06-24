#!/usr/bin/env node
// scripts/probe-opencode-sdk.mjs
// M0 go/no-go 探针 —— 在真实运行的 OpenCode 实例上验证
// references/opencode-native-team-plugin-design.md 的 V1–V10 假设。
//
// 用法:
//   1. 启动 opencode server（例如 `opencode serve`，记下端口）
//   2. OPENCODE_BASE_URL=http://127.0.0.1:<port> \
//      PROBE_PROVIDER=anthropic PROBE_MODEL=claude-haiku-4-5 \
//      bun scripts/probe-opencode-sdk.mjs            # 或 node
//
// 退出码: 0 = GATE 全过(GO，可进 M1) / 1 = 有 GATE 失败(NO-GO，回设计)
//
// 重要: 本脚本按设计文档假设的 SDK 形状调用（client.session.create/prompt/...）。
//       若你的 opencode 版本 import/连接方式不同，先改下面的 CONNECT 区 ——
//       暴露这种差异正是 V4 的目的，不要硬改文档去迁就脚本。

// ----------------------------------------------------------- CONNECT (V4 前置)
let client;
try {
  const sdk = await import("@opencode-ai/sdk");
  const createClient = sdk.createOpencodeClient ?? sdk.default?.createOpencodeClient;
  const baseUrl = process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
  client = createClient
    ? createClient({ baseUrl })
    : new (sdk.Client ?? sdk.default)({ baseUrl });
} catch (e) {
  console.error("无法初始化 @opencode-ai/sdk client:", e?.message ?? e);
  console.error("→ 这本身就是 V4 失败信号: 调整 CONNECT 区，或确认 SDK 安装/版本/server 是否在跑。");
  process.exit(1);
}

const MODEL = {
  providerID: process.env.PROBE_PROVIDER ?? "anthropic",
  modelID:    process.env.PROBE_MODEL    ?? "claude-haiku-4-5",
};

const R = {};                                  // 结果汇总
const text = (x) => JSON.stringify(x ?? "").toLowerCase();
const newSession = async (title) => {
  const s = await client.session.create({ body: { title } });
  return s?.id ?? s?.data?.id ?? s?.info?.id;  // 取值路径容错
};
const del = async (id) => { try { if (id) await client.session.delete({ path: { id } }); } catch {} };

// --------------------------------------------------- V4 (GATE,无退路): 方法齐全
try {
  R.V4 = ["create", "prompt", "delete"].every((k) => typeof client.session?.[k] === "function");
  R.V4_detail = {
    abort:    typeof client.session?.abort === "function",
    messages: typeof client.session?.messages === "function",
    update:   typeof client.session?.update === "function",
  };
} catch (e) { R.V4 = false; R.V4_detail = String(e); }

// ------------------------------------------ V2 (与 V1 互斥): noReply 角色约束累积
// 按 D2 真实用法测：注入"角色约束"而非只测 codeword 记忆。
try {
  const id = await newSession("probe-v2");
  await client.session.prompt({ path: { id }, body: { noReply: true,
    parts: [{ type: "text", text: "From now on you speak ONLY in pirate slang; every reply MUST contain 'Arrr'." }] } });
  const r = await client.session.prompt({ path: { id },
    body: { parts: [{ type: "text", text: "Say hello in one short sentence." }] } });
  R.V2 = text(r).includes("arrr");             // true = 角色约束累积生效（D2 两步注入可用）
  await del(id);
} catch (e) { R.V2 = false; R.V2_detail = String(e); }

// ----------------------------------------- V1 (与 V2 互斥): session 接受 agent 绑定
try {
  const id = await newSession("probe-v1");
  let bound = false;
  try {
    await client.session.prompt({ path: { id },
      body: { agent: "build", noReply: true, parts: [{ type: "text", text: "ok" }] } });
    bound = true;                              // 未抛错 = body.agent 被接受（可走绑定路线）
  } catch {}
  R.V1 = bound;
  await del(id);
} catch (e) { R.V1 = false; R.V1_detail = String(e); }

// -------------------------------- V6 (GATE,有YAML退路) + V3: format json_schema
try {
  const id = await newSession("probe-v6");
  const r = await client.session.prompt({ path: { id }, body: {
    model: MODEL,
    parts: [{ type: "text", text: 'Return the JSON object {"a":1} and nothing else.' }],
    format: { type: "json_schema",
              schema: { type: "object", properties: { a: { type: "number" } }, required: ["a"], additionalProperties: false },
              retryCount: 1 } } });
  const out = r?.data?.info?.structured_output ?? r?.info?.structured_output ?? r?.structured_output;
  R.V6 = out?.a === 1;
  R.V3 = out != null;                          // V3: 取值路径核对
  R.V3_detail = out != null
    ? "structured_output 命中（沿用文档路径）"
    : "structured_output 取不到 → M1 需回退 session.messages 解析";
  await del(id);
} catch (e) { R.V6 = false; R.V6_detail = String(e) + " → 退路: fenced-YAML"; }

// ------------------------------------------- V7 (GATE,无退路): model 字段结构
try {
  const id = await newSession("probe-v7");
  const tryModel = async (m) => {
    try { await client.session.prompt({ path: { id },
      body: { model: m, noReply: true, parts: [{ type: "text", text: "ok" }] } }); return true; }
    catch { return false; }
  };
  const asObject = await tryModel(MODEL);
  const asString = await tryModel(`${MODEL.providerID}/${MODEL.modelID}`);
  R.V7 = asObject ? "object" : asString ? "string" : "unknown";
  await del(id);
} catch (e) { R.V7 = "unknown"; R.V7_detail = String(e); }

// ------------------------------------- V8 (GATE,无退路): session 间 API 级隔离
// 注意：仅覆盖 API 级（messages 不串）。模型级/缓存级泄漏（正常架构下不存在）不在覆盖范围。
try {
  const SECRET = "SECRET-FOR-A-ONLY-98765";
  const a = await newSession("probe-v8-a");
  await client.session.prompt({ path: { id: a }, body: { parts: [{ type: "text", text: SECRET }] } });
  const b = await newSession("probe-v8-b");
  const bMsgs = await client.session.messages({ path: { id: b } });
  R.V8 = !text(bMsgs).includes(SECRET.toLowerCase());   // true = API 级隔离成立
  await del(a); await del(b);
} catch (e) { R.V8 = false; R.V8_detail = String(e); }

// ------------------------------------------------- V5 (细节): 并发上限观测
try {
  const ids = await Promise.all(Array.from({ length: 6 }, (_, i) => newSession(`probe-v5-${i}`)));
  const rs = await Promise.allSettled(ids.map((id) =>
    client.session.prompt({ path: { id }, body: { model: MODEL, parts: [{ type: "text", text: "reply 'ok'" }] } })));
  R.V5 = `${rs.filter((x) => x.status === "fulfilled").length}/6 并发成功`;
  await Promise.all(ids.map(del));
} catch (e) { R.V5 = "unknown"; R.V5_detail = String(e); }

// ----------------------------------------------- V9 (细节): abort / delete 可用
R.V9 = {
  abort:  typeof client.session?.abort === "function",
  delete: typeof client.session?.delete === "function",
};

// --------------------------- V10 (细节): create/update 接受 tools(机制级只读)
try {
  let accepted = false;
  try {
    const s = await client.session.create({ body: { title: "probe-v10", tools: { write: false, edit: false, bash: false } } });
    const id = s?.id ?? s?.data?.id ?? s?.info?.id;
    accepted = !!id;
    await del(id);
  } catch {}
  R.V10 = accepted;                            // true = 可上机制级只读；false = 只读靠模型自律（软约束）
} catch (e) { R.V10 = false; R.V10_detail = String(e); }

// -------------------------------------------------------- 汇总 + GATE 判定
// GATE 逻辑（与设计文档 §10 一致）:
//   必过(无退路): V4、V7(≠unknown)、V8
//   角色注入:     V1 ∨ V2 至少一过
//   V6:           不进硬 GATE —— 不过则强制走 fenced-YAML 退路（M1 返工），不阻塞 GO
const gatePass =
  R.V4 === true &&
  R.V7 !== "unknown" &&
  R.V8 === true &&
  (R.V1 === true || R.V2 === true);

console.log("\n=== M0 探针原始结果 ===");
console.log(JSON.stringify(R, null, 2));

console.log("\n=== GATE 判定 ===");
console.log(`V4  (必过)         : ${R.V4 === true ? "PASS" : "FAIL"}`);
console.log(`V7  (必过)         : ${R.V7 !== "unknown" ? `PASS (model=${R.V7})` : "FAIL"}`);
console.log(`V8  (必过, API级)  : ${R.V8 === true ? "PASS" : "FAIL"}`);
console.log(`V1∨V2 (角色注入)   : ${(R.V1 || R.V2) ? `PASS (V1=${R.V1}, V2=${R.V2})` : "FAIL"}`);
console.log(`V6  (有YAML退路)   : ${R.V6 === true ? "PASS (走 json_schema)" : "FALLBACK (走 fenced-YAML, M1 需补解析)"}`);
console.log(`V3/V5/V9/V10 (细节): V3=${R.V3} V5=${R.V5} V9=${JSON.stringify(R.V9)} V10=${R.V10}`);

console.log(`\n→ ${gatePass ? "GO ✅  可进 M1" : "NO-GO ❌  回设计"}`);
if (gatePass && R.V6 !== true) console.log("   （注意: V6 未过，M1 必须实现 fenced-YAML 退路而非 json_schema）");
if (gatePass && R.V10 !== true) console.log("   （注意: V10 未过，reviewer 只读为软约束，须在报告中明示）");

process.exit(gatePass ? 0 : 1);
