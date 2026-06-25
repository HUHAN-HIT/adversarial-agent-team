# 设计文档：原生 OpenCode 对抗式团队插件（Native Adversarial Team Plugin）

- **状态：** Draft v2.1（第二轮评审修订）。**定位：待验证的设计假设** —— §10 的 GATE 项（V4/V7/V8 必过、V6 须落入退路、V1∨V2 至少一过）未达成前，不得进 M1。
- **日期：** 2026-06-18
- **目标读者：** 实现者（写这个 plugin 的人或 agent）
- **关联：** 本文是 `adversarial-agent-team` skill 的 **Mode C2 — 原生 OpenCode 真团队** 适配方案，与 `references/opencode-adapter.md`（Mode C，subagent）并列。
- **不依赖：** oh-my-opencode / oh-my-openagent / 任何第三方编排插件。只用原生 OpenCode plugin + `@opencode-ai/sdk`。
- **总工作量估计：** M0 探针 0.5 天（go/no-go gate）+ M1 2–3 天 + M2 0.5 天 + M3 0.5 天 ≈ **3.5–4.5 天**（v1 估计 2.5 天偏乐观，见 §13）。

---

## 1. 目标与非目标

### 目标
1. 让 `adversarial-agent-team` skill 在**原生 OpenCode** 上跑出"真团队"效果：多个 reviewer 在**各自独立的 context window** 中并行、独立产出 findings，再汇总仲裁——而不是退化成单 subagent 自己 role-play（上轮发现的 Mode C 退化问题）。
2. **不经过 Task tool，直接使用 SDK `session.*`。** Task tool 的 `subagent_type` 枚举硬编码、自定义 subagent 调不动（见 issue #29616/#20059/#3715），但 SDK `session.*` 是公开 API；本方案走 SDK，不是规避安全机制。
3. 输出严格对齐 skill 现有的 `output-schema.md`（findings / cross-exam / arbitration）。

### 非目标
- 不复刻 omo team-core 的通用协作设施（常驻 mailbox / poll / worktree / tmux / resume / 任务依赖 / claim 竞争）。对抗式评审用不上（见 §5 D1）。
- 不做 peer-to-peer 持续聊天。reviewer 之间默认**零通信**（这正是"真独立"的要求）。
- 不追求崩溃恢复 / 长生命周期。评审是短任务，状态留内存即可。

---

## 2. 背景与动机

OpenCode 原生只有 `primary → subagent` 的单向层级委派，没有 Claude Code 那种 agent team。但 `@opencode-ai/sdk` 暴露的 `session.*` + plugin 的自定义 tool + `event.subscribe()` 三件套，足以在原生之上自建一个**对抗式评审专用**的轻量团队层。omo 已用同样的底座做出了通用 team mode（78 文件的 team-core + adapter），证明底座足够；本方案只取其中对抗式评审需要的极小子集。

**C2 相对 Claude Code Mode B 的卖点：** Mode B（Claude Code 原生 agent teams，实验性）也实现了"真独立 context 的多 reviewer"，但成本是 Mode A 的 3–10× tokens（见 `workflow.md:18`）。C2 用 SDK `session.create` 起 N 个独立 session 拿到同样的独立性，却不必为持续 mailbox/poll/teammate-之间消息付费 —— 对抗式评审是短任务，fan-out + 收集即可。

**成本现实化（M-1）：** "接近 Mode A" 是分 size 的：
- **Minimal**（2 reviewer + lead arbiter）：每个 reviewer 收 1 份 evidence，最接近 Mode A。
- **Standard**（4–6 reviewer + 独立 arbiter）：evidence 被传 N+1 次。
- **Full**（6–8+ reviewer + cross-examiner + 独立 arbiter）：evidence 被传 N+2 次，cross-examiner 还要再收所有 findings —— 成本居中（高于 Mode A，仍低于 Mode B 的 3–10×）。
- **fan-out 的 evidence N× 传输是大 evidence 的主要成本放大点**：`workflow.md:76-79` 已要求 evidence pack 紧凑（chunk/sample + `known_unknowns`），C2 受益于此。若 evidence 本身大，C2 Full 的 token 成本可能逼近 Mode A 的 2–3×，而非"接近"。

---

## 3. 设计原则

1. **Fan-out 优先，mailbox 退场。** 评审主体是"派发同一份 evidence → 各自独立产出 → 汇总"，用 `Promise.all` 并行即可，不需要消息总线。
2. **独立性是第一性的。** 每个 reviewer 是**新建的独立 session**，prompt 里**只含 evidence pack + 自己的角色身份**，绝不含其他 reviewer 的输出。这从机制上保证 skill 要求的"真独立"。
3. **结构化优先。** 用 SDK 的 `format: json_schema` 让每个 reviewer 直接返回校验过的 findings，免 YAML 解析与重试地狱。
4. **薄。** 单文件 plugin，核心 ≤ ~300 行。能砍的全砍。
5. **降级而非失败。** 任一 reviewer 失败/超时/产出非法 → 记为 gap，不中断整体（对齐 `workflow.md` Robustness）。

---

## 4. 架构概览

### 4.1 原生 API 映射

| 团队能力 | 原生 OpenCode API | 备注 |
|---|---|---|
| 起一个独立 reviewer | `client.session.create({ body:{ title } })` | 每个 = 独立 context |
| 注入角色身份（不触发回复） | `client.session.prompt({ path:{id}, body:{ noReply:true, parts:[system] } })` | `noReply` 是官方"for plugins"字段 |
| 让 reviewer 产出 findings | `client.session.prompt({ path:{id}, body:{ parts:[evidence+指令], model, format:{type:"json_schema",schema} } })` | 返回 `data.info.structured_output` |
| 逐角色换模型（跨 provider） | `body.model = { providerID, modelID }` | 跨厂混用 |
| 读 reviewer 产出（兜底） | `client.session.messages({ path:{id} })` | json_schema 失败时回退解析 |
| 异步感知完成（可选） | `client.event.subscribe()` → 监听 `session.idle` | fan-out 用 `await Promise.all` 即可，通常不需要 |
| reviewer 调用入口 | plugin `tool({ description, args, execute })` | 注册 `adversarial_review` 等 |
| 共享状态 | plugin 进程内对象（Map） | 短生命周期，无需落盘 |

### 4.2 数据流（Standard size）

```
lead session (主对话, 扮演 Coordinator+Arbiter)
   │  调用 tool: adversarial_review(evidence, roles, size)
   ▼
[plugin.execute]
   │  Promise.all:
   ├─ create+prompt → pro session        (独立 ctx, json_schema) ┐
   ├─ create+prompt → con session         (独立 ctx, json_schema) ├─ 并行
   ├─ create+prompt → security session    (独立 ctx, json_schema) │
   └─ create+prompt → correctness session (独立 ctx, json_schema) ┘
   │  收集 structured_output[]，逐个校验 / 降级
   │  (Full size) → create+prompt cross-examiner session(喂 pro+con+维度 findings，B5)
   │  delete 所有 reviewer session
   ▼
返回 { findings:[...], crossExam? } 给 lead
   │
lead 扮演 Arbiter：按 output-schema 的 arbitration 块裁决（never average）
   │
lead 或独立 scribe session → 渲染 report-template.md
```

---

## 5. 关键设计决策

### D1 — Fan-out，不做常驻 mailbox
- **决策：** reviewer 间不通信；用并行 `session.prompt` 收集。
- **理由：** Minimal/Standard 的 pro/con/维度都是独立产出，无需互看。砍掉 mailbox/poll/reservation/recovery（omo 那一整块）。
- **备选：** 若将来要"持续多轮辩论"，再引入基于 `session.prompt(noReply)` + `event.subscribe` 的回合制投递。当前 YAGNI。

### D2 — 角色身份用 `noReply` 注入，不依赖 agent 绑定
- **决策：** 每个 reviewer session 先 `prompt({noReply:true, parts:[角色 system prompt]})` 注入身份，再正式 `prompt` 给 evidence + 出 findings。角色 prompt 取自 plugin 内置的 `roles.md` 副本（见 D7）。
- **理由：** `noReply` 注入是文档明确支持、且 M0 实测可用的最稳路径，让角色与 skill 的 `roles.md` 单一来源对齐，无需维护 OpenCode agent 文件。
- **~~备选：agent 绑定~~（已删 —— M0 实测 V1 假阳性）：** `session.prompt` 类型上有 `agent` 字段，但 1.2.27 运行时**忽略**它（真/假 agent 名都不报错、都不生效）。agent 绑定不可行，**锁定 noReply 两步注入**，不再保留该开关。
- **架构级风险（V2，原 GATE）→ 实测 PASS：** `noReply:true` 注入的角色约束**确实**在后续同 session prompt 中累积生效（M0 pirate-slang 探针验证）。两步注入模式成立，无需退路。

### D3 — findings 用 `format: json_schema`（GATE：V6）
- **决策：** reviewer 输出走 JSON schema（§6.5），不走自由文本 YAML。
- **理由：** SDK 内置校验 + 重试（`retryCount`），免去 skill 原来"YAML 非法→重提一次"的脆弱逻辑。
- **风险：** schema 太复杂模型填不好 → 保持 schema 扁平（claims 数组 + 枚举），与 `output-schema.md` 同构。
- **架构级风险（V6，GATE）：** 若 SDK 不支持 `body.format: { type:"json_schema", schema, retryCount }`，退路不是"兜底 `session.messages` 解析"，而是 **回到 skill 原本的 fenced-YAML 流程**：模型产出 ```yaml 块 → plugin 解析 → 失败重提一次 → 再失败标 `schema_violation`（与 `workflow.md:111-114` Robustness 条款同构）。两层退路要在 M0 探针时同时验证。

### D4 — 逐角色模型（per-prompt `model`）
- **决策：** 每个角色可配独立 `model`。重推理角色（con/security/arbiter）给强模型，轻量维度给快模型，scribe 给写作友好模型。
- **理由：** 这是原生 SDK 免费给的能力，且是相对 Claude Code 的增量优势（跨 provider 混用）。

### D5 — 状态留内存
- **决策：** 一次 `adversarial_review` 调用内用局部变量持有 session id 列表与结果；调用结束即清理。
- **理由：** 评审是单次短任务，无需 `state.json`/锁/resume。

### D6 — Arbiter 由谁担任，按 size 分级
- **决策：**
  - **Minimal：** Arbiter 由 lead（主 session）担任。lead 同时是 Coordinator+Arbiter，省一个 session。
  - **Standard / Full（建议默认）：** 开启 `independentArbiter`，由独立 arbiter session 产出 arbitration 块。**编排契约：** Standard/Full 下 `adversarial_review` **内部**串联 arbiter 并把 arbitration 随返回带回（lead 单次调用即可）；`adversarial_arbitrate(findings, crossExam)` 同时保留为可被 lead **单独调用**的工具（重仲裁，或 Minimal 显式开启）。
- **理由：** skill 全程强调独立性（`SKILL.md:15-18`）。Minimal 起的 session 少（2 个），lead 仲裁可接受；Standard/Full 已起 4–8+ session，多一个 arbiter 边际成本低，且能消除"lead 既要建 evidence pack、选 role、又要仲裁"的三重身份偏置。
- **权衡：** `independentArbiter:true` 增加一次 session 调用 + 等待；Minimal 场景下不划算。

### D7 — roles 用短名查表，不让 lead 拼装 systemPrompt
- **决策：** plugin 内置 `roles.md` 的副本（含每个角色的 systemPrompt 段落），lead 调用工具时只传角色**短名**（`"con"` / `"security-reviewer"`），plugin 自己查表注入。
- **理由：** lead 是 LLM，让它把 `roles.md` 整段复制到 `systemPrompt` 字段里易被截断/改写，且破坏单一来源。短名调用既稳又省 token。
- **同步约束：** plugin 内置副本与 `references/roles.md` 是**镜像关系**——改一处必须改另一处。与 §8 第4项的 schema 同步规则一致：在两份文件顶部加注释互指。
- **`ROLE_PROMPTS` 必须覆盖的短名**（独立 session 会注入的角色）：`pro`、`con`、12 个维度（code 池 7：`correctness-reviewer`/`security-reviewer`/`test-reviewer`/`architecture-reviewer`/`performance-reviewer`/`ops-reviewer`/`ux-api-reviewer`；goal 池 5：`feasibility-reviewer`/`risk-reviewer`/`impact-reviewer`/`assumption-reviewer`/`implementation-reviewer`）、`cross-examiner`、`arbiter`。`coordinator` 与 `scribe` 由 lead 主 session 担任（D6/D8），**不进** `ROLE_PROMPTS`。

### D8 — Scribe 默认由 lead 担任，去掉独立 scribe session
- **决策：** scribe 永远是 lead 自己，不在 plugin 内起独立 scribe session。
- **理由：** v1 设计三处对 scribe 描述不一致（§6.2 配 model / §6.3 工具不返回 arbitration / §7 "独立 session 或 lead 自身"）。scribe 要吃 findings+crossExam+arbitration 才能成文，而 arbitration 在工具外由 lead（或 independentArbiter）产出 —— 让独立 scribe session 拿全这些输入的串接逻辑不在工具签名里，会导致实现者卡住。
- **可选：** 若未来确实需要独立 scribe（如让写作友好模型专门成文），新增 `adversarial_scribe` 工具，签名 `(findings, crossExam?, arbitration, reportTemplate) → markdown`。当前 YAGNI。

---

## 6. 组件与接口

### 6.1 形态与放置
- 双文件（M1 实测拆分）：`adversarial-team.js`（薄 plugin shim，注册工具）+ `adversarial-engine.mjs`（纯引擎，可被 harness 直接 import 真跑，不依赖 plugin host）。opencode 1.2.27 的 plugin 目录约定为 `.opencode/plugin/`（**单数**，项目级）或 `~/.config/opencode/plugin/`（全局）；本 skill 的可部署副本放 `assets/opencode/plugin/`。（部署时以 opencode 启动日志中的工具注册为准确认目录名。）
- 导出一个 plugin 函数，注册 1（最小）~3（完整）个工具。

### 6.2 配置（角色与模型）
读取 `.opencode/adversarial-team.json`（可选；缺省用内置默认）：
```jsonc
{
  "defaultModel": { "providerID": "anthropic", "modelID": "claude-..." },
  "roleModels": {
    "con":      { "providerID": "anthropic", "modelID": "claude-...-opus" },
    "security": { "providerID": "openai",    "modelID": "gpt-..." }
    // 不再有 scribe 条目：scribe 由 lead 担任（见 D8）
  },
  "maxParallel": 5,
  "perRoleTimeoutMs": 180000,
  // Minimal 可 false；Standard/Full 建议 true（见 D6）
  "independentArbiter": "auto"   // "auto" = Minimal→false, Standard/Full→true；或显式 true/false
}
```
角色 **system prompt** 不放配置，也不由调用方拼装 —— plugin 内置 `roles.md` 副本，调用方只传角色短名，plugin 查表注入（见 D7）。`roleModels` 是**逐角色模型覆盖**，key 是短名（`pro`/`con`/`security-reviewer`/...）。

### 6.3 工具：`adversarial_review`（核心）
```
args:
  evidence:  string            # 序列化后的 evidence pack(output-schema 的 evidence 块)
  roles:     array<{           # 由 lead 依 workflow 维度选择表选出
               name:         string   # 角色短名，e.g. "con", "security-reviewer"
               stance:       "pro"|"con"|"dimension"
               dimension?:   string   # stance==dimension 时
               # 不再传 systemPrompt —— plugin 按 name 查内置 roles.md 副本（D7）
               model?:       {providerID,modelID}  # 覆盖 cfg.roleModels[name] 与 defaultModel
             }>
  size:      "minimal"|"standard"|"full"
  crossExam?: boolean          # Full 默认 true
返回: JSON 字符串
  { findings: Finding[],       # 见 6.5
    crossExam?: CrossExam,     # crossExam 为真时
    arbitration?: Arbitration, # independentArbiter 生效（Standard/Full 或显式 true）时，工具内部串独立 arbiter session 产出并带回（见 6.5/D6）；Minimal 缺省，由 lead 自仲裁
    gaps: Gap[] }              # 失败/超时/非法的角色 —— 见下方"转译规则"
```

**`gaps` 转译规则（B2，对接 `output-schema.md`）：** plugin 返回的 `gaps` **不直接进 schema**。lead 收到后必须按下表转译：

| gap 类型 | 转译到 |
|---|---|
| reviewer 失败/超时/空产出 | lead 在报告中该角色本应贡献的 `findings.open_questions` 注明缺失（或独立列 Open Questions） |
| cross-examiner 失败（Full） | lead 在 `arbitration.arbiter_discovered_gaps` 注明"cross-exam 缺失，disputed_points 未锐化" |
| reviewer schema 违反 | 原始片段以 `severity: note, confidence: low` 的 finding 入 `findings.claims`，标 `schema_violation`（对齐 `workflow.md:111-114`） |

每个 `Gap` 形如 `{ role: string, kind: "timeout"|"empty"|"schema_violation"|"error", detail: string }`。

### 6.4 工具：`adversarial_cross_exam`（可选，也可内联进上面）
```
args: { proFinding, conFinding, dimensionFindings[] }
返回: CrossExam(JSON)   # 见 6.5；起一个独立 cross-examiner session，喂各方 findings
```

### 6.5 数据结构（JSON Schema，对接 `output-schema.md`）

> **M0 实测修正：** 1.2.27 SDK 无 `body.format`/`structured_output`，下列 schema **不**经 SDK 校验，而是由 plugin 侧对模型产出的 fenced 块做解析+校验（先 `JSON.parse`，失败走受限 YAML 子集解析；再失败标 `schema_violation` + 重提一次）。schema 形状仍是 plugin 校验器的唯一真源，与 `output-schema.md` 同构。

**FINDINGS_SCHEMA**（= output-schema.md 的 findings 块）：
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "agent":     { "type": "string" },
    "stance":    { "enum": ["pro", "con", "dimension"] },
    "dimension": { "type": "string" },
    "summary":   { "type": "string" },
    "claims": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id":                 { "type": "string" },
          "claim":              { "type": "string" },
          "evidence":           { "type": "string" },
          "severity":           { "enum": ["blocker","high","medium","low","note"] },
          "confidence":         { "enum": ["high","medium","low"] },
          "recommended_action": { "type": "string" }
        },
        "required": ["id","claim","evidence","severity","confidence"]
      }
    },
    "open_questions": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["agent","stance","summary","claims"]
}
```

**CROSS_EXAM_SCHEMA**（= cross-exam 块）：`strongest_pro_claims[] / strongest_con_claims[] / disputed_points[] / unsupported_claims[] / evidence_gaps[] / questions_for_arbiter[]`，均为 string 数组。

**ARBITRATION_SCHEMA**（= arbitration 块，仅 `independentArbiter` 时由工具产出）：`decision(enum) / risk_level(enum) / confidence(enum) / required_changes[] / optional_improvements[] / residual_risks[] / arbiter_discovered_gaps[] / reasoning(string)`。

### 6.6 角色 prompt 注入顺序（每个 reviewer session）
1. `session.create` → 得 `id`（**实测取值路径 = `res.data.id`**；create 返回 `{ data:{ id, slug, version, directory… } }`）。
2. `session.prompt({ path:{id}, body:{ noReply:true, parts:[{type:"text", text: SHARED_CONTRACT_C2 + "\n\n" + ROLE_PROMPTS[role.name] }] }})`
   —— `ROLE_PROMPTS[role.name]` 由 plugin 内置 `roles.md` 副本查表（D7）。
3. `session.prompt({ path:{id}, body:{ model, parts:[{type:"text", text:"EVIDENCE PACK:\n"+evidence+"\n\nReturn your findings."}] }})`
   —— **实测修正：** 1.2.27 `body` 无 `format` 字段、SDK 无 `structured_output`。改为：指令模型只产出**单个 fenced 代码块**（YAML；JSON 亦可，因 JSON ⊂ YAML）→ 从响应 `res.data.parts`（`type:"text"` 的 part）取文本 → plugin 侧解析+校验（先 `JSON.parse`，失败走受限 YAML 子集解析）→ 失败标 `schema_violation` + 重提一次（对齐 `workflow.md:111-114`）。
   —— `body.model` = `{providerID, modelID}`（V7 实测 object）。「可选 json_schema 分支」在 1.2.27 上无字段可挂，留作未来 SDK 增加 `body.format` 的 TODO，本版不实现。

**`SHARED_CONTRACT_C2`（C2 专属，剔除了 roles.md 的 Mode D 条款）：**
```
Use evidence first; label speculation explicitly.
Separate severity (how bad a finding is) from confidence (how sure you are).
Do not duplicate another role's job unless necessary.
Prefer actionable findings over commentary.
Preserve real disagreement.

You are running in Mode C2 (OpenCode native team plugin): you are an isolated
session. Other reviewers run in their own sessions and their outputs are not
visible to you. Your independence is structural, not a self-check.
```
**为什么不直接搬 `roles.md` 的"Shared prompt contract"：** 原文含一条 `In Mode D (single context)...` 条款，会让 C2 reviewer 误以为自己在 Mode D，从而错误地把整体置信度自评降为 medium。C2 不是 Mode D，必须剔除并替换为上面的 C2 专属声明。

---

## 7. 执行流程

**Minimal（pro + con + arbiter）**
1. lead 选角色 `[pro, con]`，调 `adversarial_review(evidence, roles, "minimal")`。
2. plugin 并行起 2 个独立 session、注入身份、出 findings、清理、返回。
3. `cfg.independentArbiter` 在 Minimal 下默认 `false` → **lead 扮演 Arbiter** 出 arbitration 块（never average，一个 blocker 压多个 approve）。若显式 `true` 则起独立 arbiter session。
4. lead（作为 scribe，D8）按 `report-template.md` 成文。

**Standard（+ 2–4 维度）**
1. lead 依 `workflow.md` 维度选择表挑维度（如 code → correctness/security/test）。
2. `adversarial_review` fan-out pro/con/维度。
3. `cfg.independentArbiter` 在 Standard 下默认 `true`（D6）→ **`adversarial_review` 内部**收齐 findings 后串一个独立 arbiter session，**arbitration 块随返回一并带回**（lead 不必二次调用）。
4. lead 拿 findings(+arbitration)，按 `report-template.md` 成文。

**Full（+ 全部相关维度 + cross-exam）**
1. `adversarial_review(..., "full", crossExam:true)`。
2. plugin 收齐 findings 后，**再起一个独立 cross-examiner session**，喂 pro+con+维度 findings，出 CrossExam。
   - **C2 对 workflow 的扩展（B5）：** `workflow.md:88-91` 的 cross-examiner 只比 pro/con；C2 把 dimension findings 也喂进去，让它能锐化"维度 vs 维度"和"维度 vs pro/con"的争议。这是有意的扩展，不是 bug。
3. `cfg.independentArbiter` 在 Full 下默认 `true` → **`adversarial_review` 内部**串独立 arbiter session（带 cross-exam 的 disputed_points / questions_for_arbiter），**arbitration 随返回带回**。
4. lead 拿 findings+crossExam+arbitration 成文。

> 独立性边界：cross-examiner 是**第一个被允许看到所有 findings 的角色**（对齐 workflow.md）。pro/con/维度始终只看 evidence。

---

## 8. 与 skill 集成（Mode C2）

1. **`references/opencode-adapter.md`**：新增 "Mode C2 — Native Team Plugin"，给检测逻辑：
   - 检测 `.opencode/plugin/adversarial-team.js` 存在 + 启动日志含工具注册 → 用 Mode C2（真团队）；
   - 否则回退 Mode C（subagent）/ Mode D。
2. **`SKILL.md` 模式表**：把 OpenCode 行拆成 `C — subagents` 与 `C2 — native team plugin`，C2 对标 Claude Code 的 Mode B（真团队，独立 context）。
3. **顺带修上轮两个 bug**（**独立 PR，先于 C2 合并**）：
   - `assets/opencode/agents/adversarial-coordinator.md:3` 的 `mode: subagent` 与 `opencode-adapter.md` 中"Coordinator 是 primary agent"的定位矛盾 → 修正为 primary agent 配置。**已确认是真 bug**，与 C2 解耦，单独提 PR，先合并，避免阻塞 C2 评审。
   - `SKILL.md` Pre-use Verification 增补 "C2：确认 plugin 工具注册成功 + 能起独立 session"。
4. **`references/output-schema.md`** 是 FINDINGS/CROSS_EXAM/ARBITRATION 三个 JSON schema 的**唯一真源**——plugin 里的 schema 必须与之同构，改一处改两处需同步（加一行注释互指）。

---

## 9. 健壮性与错误处理

| 情况 | 处理 |
|---|---|
| 某 reviewer 产出非法（json_schema 重试后仍失败） | SDK 层 `retryCount:2` 已耗尽后，该角色记入 `gaps[]` 且 `kind:"schema_violation"`，附原始文本片段；不中断；lead 按 §6.3 转译规则处理 |
| 某 reviewer 超时（`perRoleTimeoutMs`） | `session.abort`（V9 核实后） + 记 `gaps[]` 且 `kind:"timeout"`，继续 |
| 某 reviewer 空产出（SDK 返回成功但 `structured_output` 为空） | plugin 层重试一次（重发 step 3 prompt）；再空则记 `gaps[]` 且 `kind:"empty"` |
| **两层重试关系（D1）** | SDK 层 `retryCount:2` 处理 **schema 违反**；plugin 层重试只处理 **SDK 已 exhausted 且返回成功但空** 的情形。两层不叠加在同一失败原因上 —— 最坏 6 次调用只发生在"模型连续产出合法 JSON 但内容空"的极端情况 |
| 并发超 server 上限（V5 保守取 4） | 用 `maxParallel` 分批 `Promise.all`（信号量）。注意：即使 server 串行执行所有 session，`Promise.all` 仍是正确写法，只是不加速 |
| session 清理失败 | 记 warn，不影响返回（孤儿 session 由用户/重启回收） |
| 一个 blocker | Arbiter 不取平均：单 blocker 可压过多个 approve（对齐 roles.md/workflow.md） |

所有失败都"降级 + 记录"，绝不静默丢角色。

---

## 10. 待核实点（实现前必须确认 —— GATE 项未通过不进 M1）

| # | GATE | 待核实 | 影响 | 默认退路 |
|---|---|---|---|---|
| V1 | (与 V2 互斥) | `session.prompt`/`session.create` 是否接受 `agent` 字段绑定 OpenCode agent | 决定 D2 是注入还是绑定 | 与 V2 互为退路（见下方 GATE 逻辑） |
| **V2** | (与 V1 互斥) | `noReply` 注入的 system 是否在后续 prompt 的同 session 中持续生效（上下文累积） | **架构级**：决定 D2 是两步注入还是合并单 prompt | 与 V1 互为退路；若都不通过，system+evidence 合并进同一条 prompt |
| V3 | | `result.data.info.structured_output` 的确切取值路径（responseStyle=data/fields） | 取结果的代码 | **V6 通过**时：若 `structured_output` 取不到，回退 `session.messages` 取模型产出的 JSON 文本并 parse；**V6 不通过**时：随 V6 走 fenced-YAML（不在此重复） |
| **V4** | **GATE** | plugin 内 `client` 是否含完整 `session.*`（含 create/prompt/delete） | **整体可行性**：若缺失则方案塌掉 | 无（omo 已在同底座跑通，预期可用） |
| V5 | | server 默认并发上限 | `maxParallel` 取值 | 保守取 4 |
| **V6** | **GATE** | `session.prompt.body.format` 是否支持 `{type:"json_schema", schema, retryCount}` | **架构级**：决定 D3 走结构化还是 fenced-YAML | 回到 skill 原本的 fenced-YAML + 重试一次 + `schema_violation` 标记 |
| **V7** | **GATE** | `body.model` 的字段结构（`{providerID, modelID}` 对象？字符串 `"anthropic/..."`？还是别的） | **架构级**：D4 逐角色模型的所有调用点 | 若是字符串，改 cfg.roleModels 的 schema |
| **V8** | **GATE** | 由同一 plugin 创建的两个 session 之间是否**API 级隔离**（A 的 messages 读不到 B；无父子记忆/worktree/env 泄漏） | C2 核心卖点"独立 context"是否成立（API 级） | 若不隔离，方案退化为 Mode C 退化问题的另一形式 —— 必须重设计。注：探针只覆盖 API 级，模型级/缓存级泄漏不在覆盖范围 |
| V9 | | `session.abort` 与 `session.delete` 的可用性与语义（abort 后是否自动 delete） | 附录 A 的 catch/finally 清理代码 | 若 abort 不存在，只用 delete |
| V10 | | `session.create` 是否接受 tools/permission 参数，实现机制级只读 | D3 的硬约束层是否可上 | 若不支持，文档明示"只读依赖模型自律" |

**GATE 逻辑汇总（Q-3 精确化）：**
- **必过(无退路)：** V4、V7、V8。
- **必过(有退路但要返工)：** V6 —— 不通过则强制走 fenced-YAML，方案不塌但 M1 要补 YAML 解析路径。
- **互斥退路：** V1 ∨ V2 至少一个通过即可（V1 通过 → 走 agent 绑定，省一次 prompt；V2 通过 → 走 noReply 注入，不依赖 agent 绑定）。v2 早期把 V2 单标 GATE 是保守写法；精确写法是 V1/V2 互斥。
- **细节(有退路)：** V3、V5、V9、V10。

M0 探针脚本（附录 C）必须先验证上述 GATE 项全过（或落入退路），才能进 M1。

### 10.1 — M0 实测回填（2026-06-19，opencode 1.2.27 + glm-5，本机）

**GATE 判定：GO** —— V4/V7/V8 必过全过；V1∨V2 满足（V2 过）；V6 落入 fenced-YAML 退路。逐条实测：

| # | 假设 | 实测结果 | M1 采纳 |
|---|---|---|---|
| V1 | `body.agent` 绑定 agent | **假阳性**：类型有该字段，1.2.27 运行时忽略（真/假 agent 名都不报错、都不生效） | 弃用 agent 绑定 |
| V2 | `noReply` 注入累积生效 | **PASS**：pirate-slang 注入后，后续 prompt 受约束 | **锁定 noReply 两步注入** |
| V3 | `structured_output` 取值路径 | **字段不存在**：1.2.27 SDK 类型里无 `structured_output` | 改读 `res.data.parts` 文本 |
| V4 | `client.session.*` 齐全 | **PASS**：create/prompt/delete/abort/messages/update 全在 | 直接用 |
| V5 | server 并发上限 | **6/6 并发成功** | `maxParallel` 默认 4（保守可调） |
| V6 | `body.format: json_schema` | **不支持**：1.2.27 `SessionPromptData.body` 根本无 `format` 字段（非 glm 单点问题，是 SDK 面缺失） | **走 fenced-YAML 退路**；不实现 json_schema 分支 |
| V7 | `body.model` 字段结构 | **object**：`{providerID, modelID}` | 采纳对象形 |
| V8 | session 间 API 级隔离 | **PASS**：B 的 messages 读不到 A 注入的私密串 | C2 卖点成立（仅 API 级） |
| V9 | abort / delete 可用 | **PASS**：两者均在 | cleanup = abort + delete |
| V10 | `create.tools` 机制级只读 | **假阳性**：类型有 `tools` 字段，运行时忽略 | 只读 = **软约束**，报告须明示 |

**recon 补充（超出 V1–V10，本会话新验，2026-06-19）：**
- ✅ **plugin 能注册 lead 可调用的 tool**：`@opencode-ai/plugin@1.2.27` 的 `Hooks` 接口有 `tool?: { [k]: ToolDefinition }`；`PluginInput = { client, project, directory, worktree, serverUrl, $ }`，注入的 `client` = 探针同款。附录 A 的 plugin 形态对 1.2.27 有效——这是此前唯一未验证的大假设，现已落地。
- 🔍 `body` 另有 `system?: string` 字段（运行时是否真生效**未验**；比照 agent/tools「类型有、运行时忽略」前例，暂不采纳，记为 TODO，作为「单调用注入」的候选优化）。
- 版本现状：opencode app / `@opencode-ai/plugin` = `1.2.27`；独立 `@opencode-ai/sdk` 版本线 = `1.17.8`（skill harness 用）；plugin 运行时 `client` 来自 sdk `1.2.27`。两者均 hey-api `{ data, error }` 包装，引擎用防御式取值（`res?.data?.id ?? res?.id`）兼容两版。
- provider/model 实测 id：`{providerID:"glm-5", modelID:"glm-5"}`、`{providerID:"minimax-m3", modelID:"MiniMax-M3"}`，本机无 anthropic。

---

## 11. 安全与权限
- plugin 运行在 OpenCode 进程内，有完整 fs/network/shell 权限——**本插件不写文件、不跑 shell**，只调 `client.session.*`，把副作用面降到最小。
- **reviewer 只读分两层（D3）：**
  - **软约束（默认）：** 注入身份时在 system prompt 中声明"你是只读评审，不改代码"。依赖模型遵守。
  - **~~硬约束（V10）~~（已删 —— M0 实测 V10 假阳性）：** `session.create` 类型上有 `tools` 字段，但 1.2.27 运行时**忽略**它（传 `tools:{write:false,...}` 既不报错也不生效）。机制级只读**无法上**。
  - **结论（锁定）：** reviewer 只读 = **纯软约束**，依赖模型自律；报告与 skill 文档必须明示，不得宣称机制级隔离。注意区分：session 间是 **API 级隔离**（V8 PASS，A 读不到 B 的 messages），但这**不等于** reviewer 不能写仓库——只读完全靠 prompt 声明。
- evidence pack 由 lead 构造并传入，plugin 不自行抓取仓库内容，避免越权。

---

## 12. 测试与验证
1. **探针**（M0，go/no-go gate）：附录 C 的脚本验证 V1–V10。GATE 判定（与 §10「GATE 逻辑汇总」一致）：**V4/V7/V8 必过**（无退路，不过则回设计）；**V6** 不过则强制走 fenced-YAML 退路（返工，不回设计）；**V1∨V2 至少一过**（都不过则角色注入无路，回设计）。
2. **单测**：mock `client`，验证 fan-out 起 N 个 session、注入顺序、fenced 输出解析、gaps 降级、cleanup。
3. **集成**：拿一个小 diff 跑 Minimal，确认 2 个 reviewer 在不同 session、findings 合法、lead 能仲裁。
4. **独立性回归（C1）**：plugin 支持 **debug 模式**（cfg.debug=true），落盘每次 `session.prompt` 的实际 parts 到 `.opencode/adversarial-team-log/`。测试断言：传给 reviewer B 的 prompt 文本中，不含 reviewer A 的 `claims` / `summary` 内容（grep 断言）。这是机制级断言，不靠黑盒猜测。
5. **skill Pre-use Verification**：补 C2 条目。

---

## 13. 工作量与里程碑
- **M0 探针**（V1–V10；GATE：V4/V7/V8 必过、V6 须落入退路、V1∨V2 至少一过，见 §10）：~0.5 天。**GATE 未达成则回设计，不进 M1。**
- **M1 最小版**（`adversarial_review` fan-out + json_schema + 降级 + cleanup，覆盖 Minimal/Standard）：~150–250 行，**2–3 天**（v1 估 1 天偏乐观 —— 含 loadConfig/withTimeout/mapLimit/runCrossExaminer/schema 装配/降级/cleanup/plugin 注册调试，且 GATE 项任一不成立都要返工）。
- **M2 Full**（cross-examiner 第二轮 + 独立 arbiter 工具）：+~100 行，0.5 天。
- **M3 skill 集成**（Mode C2 文档 + 修上轮 bug + Pre-use 验证）：0.5 天。
- **合计：~3.5–4.5 天**（v1 估 2.5 天）。
- 对比 omo team-core 78 文件，本方案是其零头（砍掉 mailbox/worktree/tmux/state-store/resume/dependencies）。

---

## 附录 A：plugin 代码骨架（示意，非完整可跑 —— 依赖 V1–V10 核实结果调整）

> **⚠️ 此骨架已被 M0 实测修正，勿照抄。** 下方代码中的 `format:{type:"json_schema",...}`、`structured_output`、`s.id` 均**不适用于 1.2.27**（见 §10.1）：实际取值用 `s.data.id`、读 `res.data.parts` 文本、走 fenced-text 解析而非 json_schema。**可跑版以 `assets/opencode/plugin/adversarial-engine.mjs` + `adversarial-team.js`（M1 实现）为准。**

```js
// .opencode/plugins/adversarial-team.js
import { tool } from "@opencode-ai/plugin";
import { ROLE_PROMPTS } from "./roles-bundle.mjs"; // 内置 roles.md 副本，D7：与 references/roles.md 同步

// SHARED_CONTRACT_C2（B1）：剔除 roles.md 的 Mode D 条款，换成 C2 专属声明
const SHARED_CONTRACT_C2 = `Use evidence first; label speculation. Separate severity from confidence.
Do not duplicate another role's job unless necessary. Prefer actionable findings. Preserve real disagreement.

You are running in Mode C2 (OpenCode native team plugin): you are an isolated session.
Other reviewers run in their own sessions and their outputs are not visible to you.
Your independence is structural, not a self-check.`;

const FINDINGS_SCHEMA = { /* 见 §6.5 */ };

export const AdversarialTeam = async ({ client }) => {
  const cfg = await loadConfig(); // .opencode/adversarial-team.json，缺省内置

  // D7：role.systemPrompt 不再由调用方传入，按 name 查内置副本
  function resolveRole(name) {
    const sys = ROLE_PROMPTS[name];
    if (!sys) throw new Error(`unknown role: ${name}`);
    return sys;
  }

  async function runReviewer(role, evidence) {
    const sys = resolveRole(role.name);
    // V10 占位：若 session.create 支持 tools/permission，在此硬禁 write/edit/bash
    const createBody = { title: `adv-${role.name}` /*, tools: { write:false, edit:false, bash:false } */ };
    const s = await client.session.create({ body: createBody });
    if (cfg.debug) await logPrompt(s.id, "create", createBody);
    try {
      // 1) 注入角色身份（不触发回复） —— V2 GATE：若不累积，需合并进 step 2
      await client.session.prompt({
        path: { id: s.id },
        body: { noReply: true,
                parts: [{ type: "text", text: `${SHARED_CONTRACT_C2}\n\n${sys}` }] },
      });
      // 2) 给 evidence，出结构化 findings —— V6 GATE：若 format 不支持，换 fenced-YAML 路径
      const r = await withTimeout(client.session.prompt({
        path: { id: s.id },
        body: {
          model: role.model ?? cfg.roleModels?.[role.name] ?? cfg.defaultModel, // V7 GATE：字段结构
          parts: [{ type: "text", text: `EVIDENCE PACK:\n${evidence}\n\nReturn your findings.` }],
          format: { type: "json_schema", schema: FINDINGS_SCHEMA, retryCount: 2 },
        },
      }), cfg.perRoleTimeoutMs);
      if (cfg.debug) await logPrompt(s.id, "evidence", /* parts */);
      const out = r?.data?.info?.structured_output; // V3：V6 通过时若取不到，回退 session.messages 取 JSON 文本 parse；V6 不通过则走 fenced-YAML 路径
      if (!out) return { ok: false, role: role.name, gap: { kind: "empty", detail: "structured_output empty" } };
      return { ok: true, finding: { ...out, agent: role.name } };
    } catch (e) {
      try { await client.session.abort({ path: { id: s.id } }); } catch {} // V9：abort 可用性
      return { ok: false, role: role.name, gap: { kind: "timeout", detail: String(e) } };
    } finally {
      try { await client.session.delete({ path: { id: s.id } }); } catch {} // V9：delete 可用性
    }
  }

  return {
    tool: {
      adversarial_review: tool({
        description: "Fan-out pro/con/dimension reviewers in isolated sessions; collect structured findings. Use for adversarial-agent-team Mode C2.",
        args: {
          evidence: tool.schema.string(),
          roles: tool.schema.array(tool.schema.object({
            name: tool.schema.string(),       // 短名（D7），不再有 systemPrompt 字段
            stance: tool.schema.string(),
            dimension: tool.schema.string().optional(),
            model: tool.schema.object({ providerID: tool.schema.string(), modelID: tool.schema.string() }).optional(),
          })),
          size: tool.schema.string(),
          crossExam: tool.schema.boolean().optional(),
        },
        async execute({ evidence, roles, size, crossExam }) {
          // size 驱动运行时默认：crossExam（Full 默认 true）；independentArbiter 的 "auto" 解析见 D6
          const useCross = crossExam ?? (size === "full");
          const useArb   = cfg.independentArbiter === true
                        || (cfg.independentArbiter === "auto" && size !== "minimal");
          const results = await mapLimit(roles, cfg.maxParallel, r => runReviewer(r, evidence));
          const findings = results.filter(x => x.ok).map(x => x.finding);
          const gaps = results.filter(x => !x.ok).map(x => ({ role: x.role, ...x.gap })); // §6.3 转译规则

          let cross;
          if (useCross && findings.length) {
            cross = await runCrossExaminer(findings, evidence); // 独立 session，喂全部 findings（B5：含 dimension）
          }
          // D6：Standard/Full（或显式 true）内部串独立 arbiter，arbitration 随返回带回；Minimal 缺省由 lead 自仲裁
          let arbitration;
          if (useArb && findings.length) {
            arbitration = await runArbiter(findings, cross); // 独立 arbiter session，出 ARBITRATION_SCHEMA
          }
          return JSON.stringify({ findings, crossExam: cross, arbitration, gaps });
        },
      }),
      adversarial_arbitrate: cfg.independentArbiter === true || cfg.independentArbiter === "auto"
        ? tool({ /* 独立 arbiter session，吃 findings+crossExam，出 arbitration 块；D6 */ })
        : undefined,
      // 不再有 adversarial_scribe —— scribe 由 lead 担任（D8）
    },
  };
};

// helpers: loadConfig / withTimeout / mapLimit(信号量) / runCrossExaminer / runArbiter / logPrompt 略
```

---

## 附录 B：示例角色装配（lead 侧，调用工具前）

```jsonc
// lead 依 workflow.md 维度选择表，为一个 code diff 装配 Standard size：
// 注意：只传短名 + stance + dimension；systemPrompt 由 plugin 内置副本查表（D7）
[
  { "name": "pro",                  "stance": "pro" },
  { "name": "con",                  "stance": "con",
    "model": { "providerID": "anthropic", "modelID": "claude-...-opus" } },
  { "name": "correctness-reviewer", "stance": "dimension", "dimension": "correctness" },
  { "name": "security-reviewer",    "stance": "dimension", "dimension": "security" }
]
```

---

## 附录 C：M0 探针脚本骨架（go/no-go gate，GATE 项必须全过）

```js
// scripts/probe-opencode-sdk.mjs —— 在真实 OpenCode 实例上跑，逐条验证 V1–V10
import Client from "@opencode-ai/sdk";

const c = new Client.Client(/* endpoint */);
const results = {};

// V4 GATE：client.session.* 是否齐全
results.V4 = ["create","prompt","delete","abort","messages"].every(k => typeof c.session?.[k] === "function");

// V2 GATE：noReply 注入的角色约束是否影响后续生成（按 D2 真实用法测，而非只测 codeword 记忆）
{
  const s = await c.session.create({ body: { title: "probe-v2" } });
  // 注入角色身份（与 D2 一致：system 级约束），不触发回复
  await c.session.prompt({ path: { id: s.id }, body: { noReply: true,
    parts: [{ type: "text", text: "From now on, you speak ONLY in pirate slang. Every reply must include 'Arrr'." }] } });
  // 普通 prompt 看是否受注入约束影响
  const r = await c.session.prompt({ path: { id: s.id }, body: {
    parts: [{ type: "text", text: "Say hello in one short sentence." }] } });
  const ans = (JSON.stringify(r) + "").toLowerCase();
  results.V2 = ans.includes("arrr"); // true = 角色约束累积生效（D2 两步注入可用）
  // 若 V2=false 但 V1=true，仍可行（改走 agent 绑定，见 GATE 逻辑）
  await c.session.delete({ path: { id: s.id } }).catch(() => {});
}

// V6 GATE：format: json_schema 是否支持
{
  const s = await c.session.create({ body: { title: "probe-v6" } });
  try {
    const r = await c.session.prompt({ path: { id: s.id }, body: {
      parts: [{ type: "text", text: "Return {a:1}." }],
      format: { type: "json_schema", schema: { type:"object", properties:{ a:{type:"number"} }, required:["a"], additionalProperties:false }, retryCount: 1 } } });
    const out = r?.data?.info?.structured_output;
    results.V6 = out?.a === 1;                 // 结构化输出可用
    results.V3 = !!out;                        // 取值路径核对
  } catch { results.V6 = false; /* 退路：fenced-YAML */ }
  await c.session.delete({ path: { id: s.id } }).catch(() => {});
}

// V7 GATE：model 字段结构（对象 vs 字符串）
{
  const s = await c.session.create({ body: { title: "probe-v7" } });
  const tryModel = async (m) => {
    try { await c.session.prompt({ path: { id: s.id }, body: { model: m, parts: [{type:"text", text:"ok"}], noReply: true } }); return true; }
    catch { return false; }
  };
  const asObject  = await tryModel({ providerID: "anthropic", modelID: "claude-haiku-4-5" });
  const asString  = await tryModel("anthropic/claude-haiku-4-5");
  results.V7 = asObject ? "object" : asString ? "string" : "unknown";
  await c.session.delete({ path: { id: s.id } }).catch(() => {});
}

// V8：session 间 API 级隔离 —— A 注入私密串，B 的 messages API 是否读得到
// 注意：此探针只覆盖 API 级隔离。模型级/缓存级/嵌入级泄漏（正常架构下不存在）不在覆盖范围。
{
  const a = await c.session.create({ body: { title: "probe-v8-a" } });
  await c.session.prompt({ path: { id: a.id }, body: { parts: [{type:"text", text:"SECRET-FOR-A-ONLY-98765"}] } });
  const b = await c.session.create({ body: { title: "probe-v8-b" } });
  const bMsgs = await c.session.messages({ path: { id: b.id } });
  results.V8 = !JSON.stringify(bMsgs).includes("SECRET-FOR-A-ONLY-98765"); // true = API 级隔离成立
  await c.session.delete({ path: { id: a.id } }).catch(() => {});
  await c.session.delete({ path: { id: b.id } }).catch(() => {});
}

// V1, V5, V9, V10：见 repo 实现脚本（V1 用 body.agent 试绑；V5 跑并发压测；V9 试 abort/delete；V10 试 createBody.tools）

console.log(JSON.stringify(results, null, 2));
// GATE 逻辑（精确化）：
//   - V4 必过（整体可行性，无退路）
//   - V6 必过 或 退路 fenced-YAML 已在 M1 实现中写好（V6 不过则强制走退路，不算阻塞，但要返工）
//   - V7 必过（无退路，model 字段结构错则全错）
//   - V8 必过（API 级隔离是 C2 卖点，不过则方案塌）
//   - 角色注入：V1 ∨ V2 至少一个通过即可 —— V1 通过走 agent 绑定，V2 通过走 noReply 注入，互为退路
//       （v2 早期把 V2 单标 GATE 是保守写法；精确写法是 V1/V2 互斥退路）
```
