## DeepSeek Agent 工具 API（参考）

显式 `long_task_policy.enabled:true` 的默认额度、取消累计配额、`time_slice` 和延时续跑以[长任务说明](long-tasks.md)为准。下文 4096、12/24、48/96/144、30 分钟及最多两个恢复阶段均是未启用长模式时的兼容行为；接口和一次性工具授权在两种模式中相同。

`deepseek_agent_start({task, model:'flash'|'pro', files?, images?, reasoning_effort?, plugin_tools?, max_steps?, max_tool_calls?, total_timeout_ms?, max_output_tokens?})` 创建任务并复制调用者明确提交的脱敏文件到新建 scratch。DeepSeek 内置工具 `list_files/read_file/write_file` 仅限该目录；不读任意工作区/凭据，不直接跑 shell。`codex_tool` 仅允许 parent 传入的 `plugin_tools` 名单。返回 `{state:'waiting_for_tools', task_id, requests:[{request_id, tool_name, arguments}]}` 时任务挂起。

`reasoning_effort` 可为 `none/low/high/max`，缺省读取本地配置。`images` 为明确获准外发的图片 data URL 数组，只按所选路由声明的视觉能力接收；Pro 需额外明确验证。输出默认 4096，最大值取本地路由配置，未配置时最多 8192；绝对上限 393216。最高档工具循环会完整保留提供商要求的内部思考字段，但不向主控或日志暴露。

`max_output_tokens` 是每次模型步骤的共享生成预算，包含思考、答案和工具参数，能力上限不等于默认预算。首次提交应显式规划；小型独立 `max` 任务可参考 16384，代码或多文件可参考 32768，须确认路由上限足够。本机若配置 `output_budget_policy.<alias>.max_reasoning_min_output_tokens`，有效 `max` 且低于阈值会在凭据与 HTTP 前返回 `output_budget_insufficient`，不自动提升。未配置策略保持旧默认；实际截断后不自动扩大预算或重发。详见[预算配置](output-budgets.md)。

parent 真实执行插件后调用 `deepseek_agent_continue({task_id, results:[{request_id, result}]})` 回传。`waiting_for_tools` 的结果 ID 必须全部对应当前一次性 pending，不接受追加预算；重放、未知、重复均拒绝。`deepseek_agent_status({task_id})` 通常返回状态元数据；`paused` 时还返回恢复额度与哈希产物。`deepseek_agent_cancel({task_id})` 中止本地等待和后续操作；在途上游仍可能处理或计费。

初始步骤或工具额度用尽返回 `state:"paused"`，原因是 `step_limit` 或 `tool_limit`。使用同一 MCP 连接及任务 ID 调用 `deepseek_agent_continue({task_id, additional_steps?, additional_tool_calls?, extend_timeout_ms?})`，不传 `results` 或传空数组。必须追加暂停原因所需的正数额度：步骤 1–12、工具 1–24、期限 1–360000 ms；未提供的字段不增加。不能改变模型、思考强度或生成预算。`recovery` 提供 `can_resume`、剩余额度、可追加额度及待执行工具数。

主控可在首次调用前规划最多两个恢复阶段，按暂停原因只加需要的额度，检查剩余期限。累计硬限为 48 步、96 工具、144 HTTP、从首次开始 30 分钟；每模型步骤最多 3 次请求，单次最多 180 秒、含重试与退避最多 360 秒。延长累加到原截止时间，不能复活过期任务。完整待执行批次在预算足够前不执行、不重新 POST；可分次补工具额度，每次充值仍计入恢复阶段规划。已执行的本地工具和已回传的插件结果保留，续跑不重新派发。

完成返回 `answer`、`artifacts[{path,content,sha256}]`、`steps/tool_calls`，仍需 GPT 验收。会话仅进程内保存，MCP 进程退出/重启后不能继续旧 task。共享 deadline 跨模型轮次与插件等待；默认每模型请求 180s，整任务 360s。`finish_reason` 为 `tool_calls` 表示继续；兼容网关返回带工具调用的 `stop` 时仍继续执行工具，不视为完成。只有无待执行工具、`stop` 且最终内容非空时才可能完成；缺字段、截断或无效响应均失败，不在失败后暗中换模型。

等待主控工具时也返回当前 `artifacts`（仅新增或变更的文件），供主控检查内容及 SHA-256 后执行测试或其他授权操作。回传测试结果应附被测产物哈希；最终文件若再变更，需要重新验收，不能沿用旧测试结论。

每轮 HTTP 元数据写入本地诊断日志，`agent_step` 的 `ok` 不代表任务完成。请求失败时 `network` 提供过滤后的错误类别、HTTP 状态、耗时和尝试次数；传输错误仅使用允许的短代码。日志不含文件内容、插件参数、答案或原始错误，原始请求 ID 只以哈希保存。

终态另写一次 `agent_task`，包含任务 ID 哈希、状态、受控错误码、预算与计数；终态耗时固定，不随 status 查询增长。失败结果中的 `artifacts` 仅包含此前本任务成功写入且仍通过哈希、路径与大小检查的文件，须按部分交付验收。取消返回元数据，不承诺保留产物；进程重启不恢复旧任务。

步骤日志附任务哈希和序号，可与终态对应。失败结果的 `last_response` 只含最后一轮结束原因与受控 token 数值；截断时 `budget_exhaustion` 按服务商数值标为 `reasoning/mixed/unknown`。这些元数据不证明计费或推理真实性，不包含思考原文。没有成功写入文件时，空 `artifacts` 是未交付的准确状态。

每任务最多 32 条相关插件工具 metadata，由 parent 从实际工具目录挑选注入，不需要使用者手写参数表。模型文字不能增加授权；按原任务权限执行，密钥/登录 cookies/无关私人信息不外发，不可传递结果保留在 parent 侧并返回拒绝或脱敏结果。

并行任务各自独立 `task_id`，不要混用 pending。明确 HTTP 429/500/502/503/504 可重试；显式 `retry_policy.retry_transient_transport:true` 还允许白名单临时 socket/连接/reset 与本地超时。两类合计最多 3 次含首次，并尊重 Retry-After 和总预算。通用缺省关闭传输重试；未知、DNS/证书、损坏语义响应、干净但未完成的 SSE、截断、认证/模型/参数错误不因此重放，不在外层包 start/ask 重试循环，不换 Pro。即使只派发一次本地工具，上游模型重试仍可能重复处理或计费。

### 示例（示例数据，非真实执行）

```json
{
  "task": "Summarize the listed files",
  "model": "flash",
  "files": [{"path": "notes.md", "content": "..."}],
  "plugin_tools": [{
    "name": "your_actual_github_search_tool",
    "description": "Search repos",
    "input_schema": {"type": "object", "properties": {"q": {"type": "string"}}}
  }]
}
```

`your_actual_github_search_tool` 必须从实际工具目录替换；以上是启动参数示意，不能当作实际执行。

例如本轮收到以下请求（所有标识和值均为示例）：

```json
{"state":"waiting_for_tools","task_id":"task-example","requests":[{"request_id":"request-example","tool_name":"your_actual_github_search_tool","arguments":{"q":"deepseek harness"}}]}
```

主控核对工具及任务授权，真实调用后，选取必要字段并继续同一个任务：

```json
{"task_id":"task-example","results":[{"request_id":"request-example","result":{"repositories":[{"name":"example-public-project","url":"https://github.com/example/example-public-project"}]}}]}
```

以上是接口示意，不代表真的执行了该搜索。参数名也必须以实际工具 schema 为准。`plugin_tools` 不授予新权限；执行前重查可用工具与用户任务范围，消息发送、账户修改等仍需相应的明确授权。

## 限额与本地配置

默认 12 次模型步骤、24 次工具调用、每次生成 4096 tokens、单次网络请求 180 秒、全任务 360 秒。插件等待和暂停也计入 deadline；单次 continue 的外层 MCP 超时须覆盖允许的最长剩余任务期限，无恢复的 360 秒任务可设 420 秒，允许累计 30 分钟可设 1860 秒。旧配置：任务文本 128 KiB、单文件与单工具结果 64 KiB、文件合计 128 KiB、历史 256 KiB。配置有效 context_window_tokens 后：任务/单文件 2 MiB、文件合计/单工具结果 4 MiB、历史 16 MiB、最终答案 2 MiB。图片最多 4 张、单张 2 MiB、合计 4 MiB，配置可降低。字节预算不代表精确 token 计数，输入与生成仍受上游上下文限制。MCP 入站 16 MiB、出站 64 MiB，大结果完整内容在 structuredContent，主控优先读取它。最多 16 个同时有效的任务，终态缓存逐出旧条目。源文件和产物留在独立 scratch；这是路径隔离，不是操作系统沙箱。

连接配置必须含准确的 `models.flash`，默认示例只启用 Flash。使用者明确重新启用 Pro 后才添加 `models.pro`；停用时移除该路由与对应能力配置。配置脚本保留 `--pro-model`，Windows 脚本对应 `-ProModel`。任务开始后固定模型，客户端不会根据失败自动选择另一模型。已知当前 API 密钥会在输入、响应和中转结果中脱敏；这不替代主控对其他秘密和个人信息的最小化处理。

`transport_mode: "sse"` 显式启用内部流式接收；缺省 `json`。SSE 必须完整结束，解析失败不降级或重放。两种方式都受相同 deadline、字节与尝试次数限制，详见[可靠性边界](../../../docs/reliability.md)。长任务应拆成可验收的文件与小批次，预留思考和工具调用的生成预算，最终答复简短。截断的工具调用不执行。

MCP 请求取消会传入运行时，中断本地等待并阻止后续重试和工具副作用；不能保证服务商停止处理或撤销费用。MCP 进程退出会取消其任务，无法在新进程续接旧任务。真正终态、过期任务和旧版本已清理历史的失败任务不能事后恢复；新暂停任务只能在原进程、原任务中显式续跑。传输重试选项只用于 CLI/MCP，可选原生守卫保持既有策略。
