# 长任务模式

此模式取消本机的累计 token、步骤、工具、HTTP 和续跑次数配额，延长正常工作时间。它不表示单次请求具有无限输出或无限上下文，也不把网络失败改成无限重发。

将下列字段合并进已有 `connection.json`，保留原连接、Flash 路由、凭据来源和能力声明：

```json
{
  "long_task_policy": {
    "enabled": true,
    "output_tokens": "route_max",
    "request_timeout_ms": 900000,
    "request_total_timeout_ms": 1800000,
    "task_timeout_ms": 7200000,
    "initial_steps": 64,
    "initial_tool_calls": 256
  }
}
```

只写 `{"long_task_policy":{"enabled":true}}` 使用同样默认值。通用配置未启用时保持旧行为。

| 项目 | 旧模式 | 启用长任务模式 |
| --- | --- | --- |
| 未指定每轮输出预算 | 4096 tokens | 本机声明的所选路由输出上限 |
| 累计 token 配额 | 无单独 token 计数器，受循环配额间接限制 | 无累计 token 配额 |
| 单次网络尝试 | 180 秒 | 900 秒，即 15 分钟 |
| 每轮请求与退避总时间 | 360 秒 | 1800 秒，即 30 分钟 |
| 初始任务期限 | 360 秒 | 7200 秒，即 2 小时 |
| 初始步骤与工具额度 | 12 / 24 | 64 / 256 |
| 累计循环上限 | 48 步 / 96 工具 / 144 HTTP / 30 分钟 | 无固定累计配额，保留安全整数检查 |

`max_output_tokens` 是该轮最多可以生成的数量，不是要求模型输出这么多。首次调用前应确认路由容量，并明确采用 `route_max` 或较小的显式预算；显式参数优先，不在失败后自动提高预算。推理、答案与工具参数仍共享这轮上限，已配置的 max 档最低预算检查仍生效。CLI 对应 `--max-output-tokens`，其请求超时参数同样可显式覆盖长模式默认值。

## 保存现场并继续

到 `step_limit/tool_limit` 时沿用原 `task_id`，按需补步骤或工具额度。长模式每次最多追加 4096 步、16384 工具，以及 86400000 ms（24 小时）；这些是单次参数范围，不是累计任务配额。主控通常按初始阶段追加 64 步、256 工具、必要的 2 小时，无需把单次范围设满。取消旧的“最多两个恢复阶段”工作规范，正常任务按进展继续，直至完成、用户取消或真正错误。

长模式还会主动返回 `pause_reason:"time_slice"`，通常每次运行窗口最多 1 小时，并在下一轮完整请求预算不足时提前交还控制。此检查点可不加步骤/工具直接 continue；若 `recovery.needs_deadline_extension:true`，应在未到期前延长原 deadline。`minimum_deadline_extension_ms` 是查询时的快照，直接照抄可能因时间经过而不足；按完整阶段（例如 7200000 ms）延时并核对返回值。不能在 `waiting_for_tools` 时混入这些预算字段；它仍只接受该轮真实一次性结果。

`additional_steps_available/additional_tool_calls_available/extend_timeout_ms_available:null` 表示没有该项本机累计配额。所有已完成结果和未执行批次仍保留，续跑不重新派发已完成的文件操作或插件结果。

MCP 外层 `tool_timeout_sec` 应覆盖一次运行窗口及收尾。可设 86460 秒，覆盖单次最大 24 小时窗口并留 60 秒；长任务通过检查点分次返回，不因累计延时扩大一次调用到多天。修改代码和 schema 后要重连 MCP，确认当前聊天的工具说明已经更新。

## 仍然存在的边界

- 服务商决定单次输出和输入加生成的上下文上限。本机 `capabilities` 是配置声明，不能验证兼容网关的实际能力；不会因官方路由容量更大就擅自提高当前网关配置。
- 保留上下文、响应体、文件、工具批次、插件名单和 MCP 帧的字节/数量校验。长任务按小文件、可验收阶段交付；保留有工具历史所需的推理字段，不丢弃历史来绕过上下文错误。
- 暂停现场只存在于原 MCP 进程。真正终态、过期任务和进程重启后的任务不能复活；已写文件可单独验收并作为明确的新阶段输入，不能把失败重发伪装成续跑。
- HTTP 与临时网络重试仍共享最多 3 次尝试，尊重 `Retry-After` 和剩余期限；取消立即停止本地等待。认证、模型、参数、坏语义响应和实际截断不自动重放、扩容或换 Pro。
- 网络层使用随 skill 分发的固定版本 Undici Agent，显式设置 header/body 等待，避免默认的 5 分钟静默超时提前终止；整体 Abort deadline 仍有效。上游也可能主动断开，客户端不能保证上游一直运行或只计费一次。

本模式只用于 CLI/MCP；可选的原生单模型 Responses 守卫保持原有预算和重试策略。GPT 继续主控，Flash 继续按原权限请求工具。

协议参考：[DeepSeek max_tokens 与上下文](https://api-docs.deepseek.com/api/create-chat-completion/)、[保活与推理开始前等待](https://api-docs.deepseek.com/quick_start/rate_limit/)、[Codex MCP 超时](https://learn.chatgpt.com/docs/extend/mcp)、[Undici Client 超时](https://undici.nodejs.org/api/Client)。
