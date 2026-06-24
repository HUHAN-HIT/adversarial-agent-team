import { createOpencodeClient } from "@opencode-ai/sdk";

const base = process.env.OPENCODE_BASE_URL || "http://127.0.0.1:4096";
const client = createOpencodeClient({ baseUrl: base });
const text = (x) => JSON.stringify(x == null ? "" : x).toLowerCase();
const mk = async (title, extra) => {
  const s = await client.session.create({ body: Object.assign({ title }, extra || {}) });
  return s && (s.id || (s.data && s.data.id) || (s.info && s.info.id));
};
const del = async (id) => { try { if (id) await client.session.delete({ path: { id } }); } catch (e) {} };
const R = {};

/* V1 deep: real agent accepted AND fake agent rejected => binding is real */
{
  const id = await mk("recheck-v1");
  let realOk = false, fakeRejected = false;
  try {
    await client.session.prompt({ path: { id }, body: { agent: "build", noReply: true, parts: [{ type: "text", text: "ok" }] } });
    realOk = true;
  } catch (e) { R.v1RealErr = String(e).slice(0, 140); }
  try {
    await client.session.prompt({ path: { id }, body: { agent: "no_such_agent_zzz", noReply: true, parts: [{ type: "text", text: "ok" }] } });
  } catch (e) { fakeRejected = true; R.v1FakeErr = String(e).slice(0, 140); }
  R.V1_realAccepted = realOk;
  R.V1_fakeRejected = fakeRejected;
  R.V1_verdict = (realOk && fakeRejected) ? "REAL-binding"
               : (realOk && !fakeRejected) ? "FALSE-POSITIVE-ignored-field"
               : "INCONCLUSIVE";
  await del(id);
}

/* V10 deep: does create reflect tools / are bad tools rejected */
{
  const s = await client.session.create({ body: { title: "recheck-v10", tools: { write: false, edit: false, bash: false } } });
  R.V10_createReturnSample = JSON.stringify(s).slice(0, 280);
  const id = s && (s.id || (s.data && s.data.id) || (s.info && s.info.id));
  let got = null;
  try { got = client.session.get ? await client.session.get({ path: { id } }) : null; } catch (e) { R.v10GetErr = String(e).slice(0, 120); }
  R.V10_getReflectsTools = got ? (text(got).includes("write") || text(got).includes("permission")) : "no-get-method";
  let badRejected = false;
  try {
    const b = await client.session.create({ body: { title: "recheck-v10-bad", tools: "not-an-object" } });
    await del(b && (b.id || (b.data && b.data.id)));
  } catch (e) { badRejected = true; }
  R.V10_badToolsRejected = badRejected;
  R.V10_note = "runtime enforcement (让模型真尝试写) 未在此复验覆盖";
  await del(id);
}

console.log(JSON.stringify(R, null, 2));
