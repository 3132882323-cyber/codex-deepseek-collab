# 客户端参数与边界

0.8.0 可显式启用[长任务模式](long-tasks.md)：每轮默认取路由输出上限、无累计 token/循环配额，单次默认 15 分钟、每轮总 30 分钟、任务 2 小时并可续。下文请求参数默认值与 48/96/144/30 分钟描述是未启用时的旧模式；长模式的 `time_slice`、长网络超时和配置范围以该说明为准。两种模式都保留协议、字节、权限和取消边界。

## 本地状态

默认目录：`${CODEX_HOME:-~/.codex}/deepseek-collaboration`。所有命令可用 `--state-dir PATH` 覆盖；PowerShell 配置脚本对应 `-StateDir PATH`。

| 文件 | 用途 |
| --- | --- |
| `connection.json` | 明确指定 HTTPS `base_url`、相同 origin 的 `allowed_origin`、`openai` 协议、准确模型及 `flash` / 可选 `pro` 别名、凭据来源和传输方式 |
| `credential.dpapi` | 仅 Windows DPAPI 方式使用的密文，不能公开或跨设备复用 |
| `diagnostics.jsonl` | 最多约 512 KiB 的安全操作元数据，轮转保留一份 previous 文件 |

示例见 [connection.example.json](../skills/deepseek-collaboration/references/connection.example.json)。`credential_source` 为 `env` 时仅使用 `DEEPSEEK_API_KEY`；缺省或 `dpapi` 时仅使用 DPAPI，二者不相互回退。配置中不要加入明文密钥。只支持模型名以 `deepseek` 开头的提供商别名，不将此检查视为上游身份认证。

`allowed_origin` 是本地配置的目标确认，不是独立信任证明。只使用你信任并授权的服务商，保护状态目录免受非授权修改。客户端不验证提供商的存储、路由或模型真实性。

默认示例仅配置 Flash。停用 Pro 时移除 `models.pro` 与对应 `capabilities.pro`；缺少路由的任务在读取凭据和联网前失败，不自动恢复配置或换模型。只有使用者明确重新启用后才添加 Pro。

`transport_mode` 可选 `json`（缺省）或 `sse`。先确认当前服务商支持流式协议，再明确设为 `sse`；CLI 与 MCP 的生成请求会发送 `stream: true` 和 `stream_options.include_usage: true`，模型列表 GET 仍用 JSON。SSE 在完整结束后转换为同一结果结构，不向终端逐字显示。接收评论与心跳、分段文字和工具调用，但必须同时收到合法结束原因与 `[DONE]`，不使用部分答案或自动切回 JSON。白名单传输异常是否可重试取决于下述显式选项；损坏帧、超限或干净结束但缺终止标记均按无效响应停止。单次期限覆盖整个响应，包括心跳，响应字节预算也包含 SSE 帧与推理内容。

官方接口会在等待中使用非流式空行或 SSE 评论维持连接；兼容网关未必保持同样行为。SSE 可改善有中间数据时的等待，不能证明或修复所有网络与上游故障。[DeepSeek 连接说明](https://api-docs.deepseek.com/quick_start/rate_limit/)

`output_budget_policy.<alias>.max_reasoning_min_output_tokens` 是可选的路由最低预算。只约束有效的 `reasoning_effort: "max"`；未配置策略时仍保留 4096 默认。配置最小值必须为安全整数并符合路由输出上限。有效 `max` 的本次预算低于阈值时，CLI/MCP 在读取凭据和联网前返回 `output_budget_insufficient`，不自动提升；调用方应在首次提交时显式规划，详见[预算策略与示例](output-budgets.md)。本地拒绝且 HTTP 次数为 0，与已经发出 HTTP 的截断不同，后者不自动重发。

## 命令

```text
deepseek-client.mjs [--state-dir PATH] status
deepseek-client.mjs [--state-dir PATH] models
deepseek-client.mjs [--state-dir PATH] ask --prompt-file PATH [options]
```

`status` 不解密 DPAPI、不联网。`ask --dry-run` 校验配置与输入，不解密 DPAPI、不联网、不写输出。`models` 做一次 GET，不应用 ask 的重试选项。`configured: true` 仅表示本地信息就绪；模型列表包含目标也不等于生成请求可用。

| ask 参数 | 默认值 / 取值 |
| --- | --- |
| `--model` | 默认配置的模型；可填已配置的别名 `flash` / `pro` |
| `--thinking` | `disabled` / `enabled`；显式值覆盖配置默认，旧配置默认 `disabled` |
| `--reasoning-effort` | `none` / `low` / `high` / `max`；缺省读取本地默认，矛盾的显式 thinking 参数会拒绝 |
| `--max-output-tokens` | 默认 4096；按路由配置限制，旧配置最多 8192，绝对范围 32–393216 |
| `--timeout-ms` | 默认 180000，单次包括完整响应体的期限 |
| `--total-timeout-ms` | 默认 360000，请求及退避总预算，最多 900000 |
| `--max-attempts` | 默认 3，范围 1–3，包含首次 |
| `--retry-base-ms` | 默认 1000，范围 1–10000 |
| `--retry-max-ms` | 默认 10000，范围 1–60000，不能小于 base |
| `--output` | 可选，原子写入本次结果 JSON；父目录需已存在 |
| `--dry-run` | 仅校验，不写 output |

CLI `ask` 输入为 UTF-8 文本；旧配置最大 128 KiB、响应最大 4 MiB；配置有效上下文窗口后分别为 2 MiB 和 16 MiB。这些是本地字节限制。此命令只发单条 user 消息，不提供工具执行器、持久会话或图像输入；传输方式读取本地配置。thinking 开启时，推理和最终内容共享生成限制；只有最终 `message.content` 作为答案。MCP 智能体的图片、工具循环与文件限制另见[能力配置](capabilities.md)和[智能体接口](../skills/deepseek-collaboration/references/agents.md)。

## 完整性与失败

先要求本次进程退出码为 0，然后读取本次 JSON。成功生成需 `ok: true`、`finish_reason: "stop"`、非空 `answer`。这只证明协议完整，事实、代码或业务结论仍需独立检查。

明确收到的 HTTP 429/500/502/503/504 按既有策略有限重试。CLI/MCP 还支持以下可选本地配置，通用缺省为 `false`，必须明确启用：

```json
{"retry_policy":{"retry_transient_transport":true}}
```

启用后，临时传输或响应体读取异常仅在短码为 `UND_ERR_SOCKET`、`ECONNRESET`、`ECONNREFUSED`、`EPIPE`、`ETIMEDOUT`、`UND_ERR_CONNECT_TIMEOUT`、`UND_ERR_HEADERS_TIMEOUT` 或 `UND_ERR_BODY_TIMEOUT` 时可重试；客户端自身的请求超时也可重试。取消、未知错误、DNS/证书错误均不因此获得重试资格。HTTP 与临时传输故障共用同一次操作最多 3 次尝试（含首次），不是各自再尝试 3 次；`--max-attempts 1` 禁止后续尝试。退避与请求共用总预算，HTTP 尊重 `Retry-After` 秒数或日期，等待超过上限或剩余预算则停止。

HTTP 200 的坏 JSON、语义/格式错误、干净结束但缺终止标记的 SSE、空答案、输出截断，以及认证、模型和参数错误仍不自动重放；不因错误信息中含 socket 字样就放行。不得叠加业务层重试循环、增加 token 预算或切换 Pro。任何传输重试都可能遇到上游已执行但本地未收到结果，无法保证上游只处理或计费一次。

此 `retry_policy` 只作用于 CLI/MCP 的共享客户端，可选原生 Responses 守卫仍采用既有的明确 HTTP 状态重试策略。CLI 的请求时间参数见上表；MCP 每个模型步骤的单次请求最多 180 秒，该步骤全部请求及退避最多 360 秒，且不超过任务剩余期限。

结果包含 attempts、elapsed_ms、http_status、error_category、过滤后的 request_id 和 attempt_history；传输错误仅返回允许的短代码。诊断日志保存相同类别的元数据，请求 ID 在写日志前转为哈希。不保存原始错误消息、响应头、错误正文、提示词或答案。远端返回的模型、用量和请求标识仍属不可信数据。

MCP 智能体的每轮 HTTP 操作以 `action: "agent_step"` 写入同一安全日志。这里的 `ok: true` 仅表示该轮请求返回，后续仍可能等待插件、被取消或因输出不完整而失败；整任务完成须检查 `state: "completed"` 并独立验收。HTTP 请求失败时，工具结果中的 `network` 仅返回 attempts、elapsed_ms、http_status、error_category 和允许的 transport_code，不回传原始请求标识或错误正文。缺少旧日志时不能事后推断某次失败的具体根因。

每个任务只在 `completed/failed/cancelled` 时以 `action: "agent_task"` 记录一次终态：模型别名、任务 ID 哈希、state、错误短码、步骤/工具/HTTP 次数、预算、产物数量与固定终态耗时。`paused` 不写终态；后续真正终态的 status/cancel 查询不重复写终态或延长其耗时。步骤可记录受控的 finish_reason、数值型 completion/reasoning token 用量与传输方式；SSE 格式错误另有白名单 `response_reason` 短码，不回传原始帧或异常文本，不记录推理原文。日志写入失败不改变任务结果。

取消会及时 abort 本地在途请求与退避等待，之后不会发起新的 POST 或执行新工具；这不能撤销已经发出的上游处理或费用。暂停和失败任务的恢复产物仅包含本任务中先前成功 `write_file` 且仍符合大小、路径与 SHA-256 校验的文件。未改动的输入文件、写入未完成或已被篡改的文件不算产物；不安全 scratch 无法收集时保留原始失败并返回空产物。取消只返回状态元数据，不承诺恢复文件或跨进程恢复。

## 同一任务内的断点续跑

首次 `start` 默认 12 次模型步骤、24 次工具调用、360 秒任务期限；显式较小的初始额度仍按原值执行。步骤或工具额度耗尽时返回 `state: "paused"`、`pause_reason: "step_limit" | "tool_limit"`、`artifacts` 与 `recovery`，保留进程内历史、已完成工具结果和未执行批次。`status` 可检查同样的暂停元数据与产物哈希，暂停不代表完成或失败。

同一 MCP 进程中使用原 `task_id` 的 `continue`，可在暂停时显式追加 `additional_steps`（1–12）、`additional_tool_calls`（1–24）及必要的 `extend_timeout_ms`（1–360000）。先检查 `recovery.can_resume`、对应剩余额度、`remaining_timeout_ms` 和追加上限；只补 `pause_reason` 对应的工作额度。未执行的完整工具批次若仍放不下，可分次补工具额度并保持暂停；`budget_added`/`last_budget_addition` 表示已追加，额度足够前不执行工具、不重新请求模型。

所有计数累计而不重置：硬上限为 48 步、96 次工具调用、144 次 HTTP，期限最多延长到首次开始后 1800000 ms（30 分钟）。HTTP 尝试计划随已授权的步骤额度增长，每模型步骤仍最多 3 次尝试。延长是在原截止时间上累加，必须在过期前操作；暂停和插件等待都计时。主控可事先规划最多两个有限恢复阶段，每阶段最多追加 12 步/24 工具及必要的 360 秒；每次补额度都计入该阶段规划，不能用分批充值规避规划或硬限额。

`waiting_for_tools` 仍须精确回传本轮所有一次性 `results`，不能同时追加预算；无 `results` 或空数组只用于暂停续跑。恢复沿最后完整响应和已完成结果前进，不重复已提交文件工具或已回传插件结果，不创建替代 `start`。真正的 `failed/cancelled/completed`、过期任务、旧版本已清理历史的失败任务，以及 MCP 重启后的旧任务都不能恢复。截断、认证、参数或模型错误不会变为可重放断点。

最高档推理可能消耗大部分输出预算。对长任务先定义较小、可验收的文件交付与生成预算，在每批写入后检查哈希，结束答复保持简短；`length/max_tokens/max_output_tokens` 一律判为截断。不能因 HTTP 200 或已有部分文件而宣称完成，也不自动扩大预算重做任务。

步骤日志新增相同的任务 ID 哈希与 `step_index`，并记录本轮输出预算和推理档位，以对应并行任务。终态和失败结果的 `last_response` 仅包含最后一轮的序号、结束原因、受控 completion/reasoning token 数；`budget_exhaustion` 仅在截断时按服务商提供的数值分为 `reasoning/mixed/unknown`。只有总生成量恰等于本轮预算、且全部为合法推理 token 时才标记 `reasoning`；缺数、越界或其他矛盾保持 `unknown`，不把上下文限制直接认作生成预算耗尽。用量来自服务商，不能证明模型身份、实际推理或计费。不会把截断输出执行为工具，也不把没有已写文件的空产物包装成成功。

安全校验后的输出目标会记录当前本地失败；非法参数、不安全目标或无法写入的路径可能只能返回非零退出码与 stderr JSON。读取旧输出时尤其需要检查本次退出码。输出不能覆盖提示词、配置、凭据或诊断日志，也不能通过符号链接或硬链接绕过这些检查。

日志写入失败不把已完成的 API 请求标记成失败；并发轮转可能丢失历史记录。客户端只按需运行，没有常驻健康监控、服务商自动切换、失败自动换模型或精确成本统计。
