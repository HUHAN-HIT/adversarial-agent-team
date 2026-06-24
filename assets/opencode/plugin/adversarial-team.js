// adversarial-team.js
// ---------------------------------------------------------------------------
// adversarial-agent-team · Mode C2 plugin shim（原生 OpenCode 真团队）。
//
// 薄注册层：把 adversarial-engine.mjs 的引擎包成 opencode 工具，lead 主 session 可调用。
// 形态对 opencode 1.2.27 已实测有效：@opencode-ai/plugin 的 Hooks.tool?: { [k]: ToolDefinition }，
// PluginInput.client = 注入的 SDK client（见设计 §10.1 recon 补充）。
//
// 部署：放到 .opencode/plugin/（项目级）或 ~/.config/opencode/plugin/（全局），
//       与 adversarial-engine.mjs 同目录。
// ---------------------------------------------------------------------------

import { tool } from "@opencode-ai/plugin";
import { createEngine, loadConfig } from "./adversarial-engine.mjs";

const z = tool.schema; // @opencode-ai/plugin 暴露的 zod

export const AdversarialTeam = async ({ client, directory }) => {
  const cfg = await loadConfig({ directory });
  const engine = createEngine({ client, cfg });

  const tools = {
    // 核心：fan-out pro/con/维度 reviewer 到各自独立 session，收结构化 findings，
    // 按 size 内联 cross-exam / 独立 arbiter（D6）。返回 JSON 字符串（gaps 转译规则见设计 §6.3）。
    adversarial_review: tool({
      description:
        "Adversarial-agent-team Mode C2: fan out Pro/Con/dimension reviewers into isolated " +
        "sessions, collect schema-valid findings, and (for standard/full) run an independent " +
        "arbiter. Returns JSON { findings, crossExam?, arbitration?, gaps }. Reviewers never see " +
        "each other's output (structural independence). The lead builds the evidence pack and " +
        "selects roles; reviewers are read-only by soft constraint only.",
      args: {
        evidence: z.string().describe("Serialized evidence pack (output-schema.md evidence block)."),
        roles: z
          .array(
            z.object({
              name: z.string().describe("Role short name, e.g. 'con', 'security-reviewer'."),
              stance: z.enum(["pro", "con", "dimension"]),
              dimension: z.string().optional().describe("Set when stance == dimension."),
              model: z
                .object({ providerID: z.string(), modelID: z.string() })
                .optional()
                .describe("Per-role model override; defaults to config roleModels/defaultModel."),
            })
          )
          .describe("Roles selected by the lead per the workflow dimension table."),
        size: z.enum(["minimal", "standard", "full"]),
        crossExam: z.boolean().optional().describe("Run cross-examiner. Defaults true for 'full'."),
      },
      async execute({ evidence, roles, size, crossExam }) {
        const out = await engine.runReview({ evidence, roles, size, crossExam });
        return JSON.stringify(out);
      },
    }),
  };

  // 可选：独立 arbiter 工具（重仲裁，或 Minimal 显式开启）。仅在 independentArbiter 非 false 时注册（D6）。
  if (cfg.independentArbiter === true || cfg.independentArbiter === "auto") {
    tools.adversarial_arbitrate = tool({
      description:
        "Adversarial-agent-team Mode C2: run an independent arbiter session over already-collected " +
        "findings (+ optional cross-exam) and return a JSON arbitration block (never averages — one " +
        "blocker can outweigh many approvals). Use for re-arbitration or explicit Minimal arbitration.",
      args: {
        findings: z.string().describe("JSON string of Finding[] (the findings array from adversarial_review)."),
        crossExam: z.string().optional().describe("JSON string of the cross-exam block, if any."),
      },
      async execute({ findings, crossExam }) {
        let f, cx;
        try { f = JSON.parse(findings); } catch (e) { return JSON.stringify({ error: "findings is not valid JSON: " + String(e?.message ?? e) }); }
        if (crossExam) { try { cx = JSON.parse(crossExam); } catch { cx = undefined; } }
        if (!Array.isArray(f) || f.length === 0) return JSON.stringify({ error: "findings must be a non-empty array" });
        const r = await engine.runArbiter(f, cx);
        return JSON.stringify(r.ok ? { arbitration: r.value } : { gaps: [r.gap] });
      },
    });
  }

  return { tool: tools };
};
// 注：opencode 约定纯 named 导出（见 @opencode-ai/plugin 的 ExamplePlugin）。不加 default 导出，避免加载器双重注册。
