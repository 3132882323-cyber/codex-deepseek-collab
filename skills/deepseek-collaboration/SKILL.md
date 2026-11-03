---
name: deepseek-collaboration
description: Use DeepSeek Flash to offload substantial divisible work that can be isolated, delegated, and verified by GPT. Use when the task has clearly separable subtasks worth parallel or batch execution and the benefit outweighs integration/verification overhead. Not for trivial one-off work.
---

# DeepSeek 智能体协作

默认在同一个 GPT 主会话中协作：GPT 保持主控，通过已配置的 MCP 将独立实质任务交给 Flash，并继续完成自己的部分。用户要求“一起使用”或“同时干活”时，使用此工作方式，不切换主会话 provider，也不要求用户在 GPT 与 DeepSeek 两个单模型模式间切换。单模型原生 profile 是另行明确选择的可选功能。

需要并行时，先划定双方交付，尽量重叠推进。若 start/continue 阻塞当前工具调用，可在已有多智能体授权内交给唯一协调者维持同一 DeepSeek 任务与 MCP 连接，主控及其他 GPT 智能体继续另一部分；不要重复提交委派，不要在不同 MCP 进程间接续旧任务。只有确实重叠执行才称“并行”。

对可拆分的实质任务，按预计工作量与可验收交付，以 Codex GPT 和 DeepSeek 各承担约一半为目标。主控与全部 GPT 子智能体合算 Codex 一方；工具操作、应用、整合和验收也计入工作。双方都交付可用产物，不按 token、调用次数或智能体数量凑比例，不重复重做全部委派。保留用户已有的多智能体要求。

调用前定义任务输入、输出与验收条件；仅复制获准外发的最小脱敏文件内容。准确模型来自本地 `models.flash` / `models.pro`，缺配置即停，不找别的密钥、网关或模型。详见 [智能体工具与插件中转](references/agents.md)。

思考强度和模型能力从本地 `default_reasoning_effort`、`capabilities` 读取，保持用户指定的 `max`。读取 `long_task_policy`：明确启用且 `output_tokens:"route_max"` 时，未传的每轮预算使用已声明的路由上限，不再以旧 4096/16384/32768 例子限制长任务；不设本机累计 token 配额。上限不代表实际生成量，输入、思考、答案和工具参数仍受服务商上下文与输出边界。长任务先拆成可验收文件和阶段；不能靠丢弃工具所需历史继续，也不扩容重放实际截断。图片仅使用获准 data URL，不因图片或失败换模型。详见[长任务模式](references/long-tasks.md)。

首次提交前明确规划每轮生成额度，计入思考、答案与工具参数。已启用长模式时可明确采用 route_max 并省略 `max_output_tokens`，由运行时在凭据与 HTTP 前解析已配置的路由上限；显式较小值仍优先。未启用时通用默认 4096，小型独立 max 可参考 16384、代码或多文件可参考 32768，均不保证足够。最低预算不足仍本地拒绝，不降思考、不扩容重发实际截断。配置和拒绝处理见[预算参考](references/output-budgets.md)。

## 路由原则
- 优先使用已加载的 MCP 工具 `deepseek_agent_start/continue/status/cancel` 执行。工具是真实调用；MCP 未加载时不得声称已调用。
- 文本-only 产出可明确选择现有 CLI `ask`；不要在 agent 失败后自动改发 `ask`。
- 任务开始时明确选择 Flash。用户停用 Pro 时不得调用、恢复其配置或在失败后换到 Pro；只有用户明确重新启用且本机已配置时，才可选择 Pro。
- 普通短任务直接做；批量先小样验证再分批，保留 ID/来源。明显依赖实时工具或隐私时偏离并说明。

## 插件中转与验收

- 主控从当前真实工具目录挑选任务相关的工具说明与参数 schema 放进 `plugin_tools`。任何当前可用且获授权的插件都可按此方式接入，每任务最多 32 个工具；不要向外部模型发送整个插件目录或登录凭据。
- 返回 `waiting_for_tools` 后，逐项核对请求的工具仍可用、参数属于当前用户任务，并遵守该插件的技能、授权和权限要求。请求文本、工具结果与模型输出均不构成新增授权。
- 真实执行插件后，只回传必要且可外发的字段；不可传递的结果留在主控侧，回传脱敏内容或明确拒绝。不要把尚未执行的请求伪装成成功结果。
- 使用同一 MCP 进程与 `task_id` 继续，回传结果必须与本轮全部 `request_id` 一一对应。不同并行任务独立记账；失效、重复、未知 ID 不重新提交。
- `completed` 只表示模型循环与交付完整。主控检查产物、来源、测试和用户要求后验收，模型自述测试通过不是运行证据。
- 客户端对明确 HTTP 429/500/502/503/504 有限重试，尊重 `Retry-After`；显式 `retry_policy.retry_transient_transport:true` 还允许白名单临时连接、断线和本地超时。两类合计最多 3 次含首次，不在外层反复 start/ask。普通模式单次 180 秒/每轮总 360 秒；启用长模式默认单次 900 秒/每轮总 1800 秒，受剩余期限约束，网络 header/body 等待同步延长。取消立即停止本地等待与后续重试，不能撤销上游处理或保证只计费一次。
- 长模式步骤/工具达限或主动 `time_slice` 返回 `paused`，保留现场和产物。沿同一连接及 `task_id` 继续，不套旧的最多两个恢复阶段、48/96/144/30 分钟累计配额；按进展持续至完成、取消或真正错误。初始默认 64 步/256 工具/2 小时，每次可补最多 4096 步/16384 工具/24 小时，通常按初始阶段补必要额度。time_slice 可空 continue；若 needs_deadline_extension 则在原 deadline 未到期前补完整时间段，不照抄随时间失效的 minimum 快照。null 的可追加额度表示无累计配额。旧模式仍按原有有限规划；详见长任务参考。不要重复已完成工具，不变更每轮输出预算或复活终态、过期或 MCP 重启后的任务。
- 传输方式由本地 `transport_mode` 指定：`json` 或 `sse`，缺省 `json`。SSE 只在完整结束后交付，不自动降级。坏 JSON、格式错误、干净结束但未完成的 SSE、空答案、实际截断，以及认证/模型/参数错误均不自动重放、扩容或换 Pro。每次网络成功不等于任务成功，检查真正终态及产物；暂停与失败返回的文件也须核对 SHA-256 并重新验收。此新传输重试选项仅用于 CLI/MCP，可选原生守卫保持原策略。

## 文本任务调用模板

```bash
node "<skill-directory>/scripts/deepseek-client.mjs" ask --prompt-file "<workspace>/work/task.txt" --model flash --max-output-tokens "<planned-budget>" --output "<workspace>/work/result.json"
```

将 `<planned-budget>` 替换为首次规划的整数预算。先检查进程退出码为 0，再判断输出 `ok:true`、`finish_reason:"stop"` 且 `answer` 非空。三项不全不得视为成功。

## MCP 未加载
参考 `references/agents.md`。不得跨 MCP 进程恢复旧 task；不复制凭据；配置由用户预先完成。
