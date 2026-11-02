## DeepSeek Agent 工具 API（参考）

`deepseek_agent_start({task, model:'flash'|'pro', files?, plugin_tools?, max_steps?, max_tool_calls?, total_timeout_ms?, max_output_tokens?})` 创建任务并复制调用者明确提交的脱敏文件到新建 scratch。DeepSeek 内置工具 `list_files/read_file/write_file` 仅限该目录；不读任意工作区/凭据，不直接跑 shell。`codex_tool` 仅允许 parent 传入的 `plugin_tools` 名单。返回 `{state:'waiting_for_tools', task_id, requests:[{request_id, tool_name, arguments}]}` 时任务挂起。

parent 真实执行插件后调用 `deepseek_agent_continue({task_id, results:[{request_id, result}]})` 回传。结果 ID 必须全部对应当前一次性 pending；重放、未知、重复均拒绝。`deepseek_agent_status({task_id})` 只返回状态元数据。`deepseek_agent_cancel({task_id})` 阻止后续操作；在途网络可能仍在处理，cancelling 不等于撤销上游费用。

完成返回 `answer`、`artifacts[{path,content,sha256}]`、`steps/tool_calls`，仍需 GPT 验收。会话仅进程内保存，MCP 进程退出/重启后不能继续旧 task。共享 deadline 跨模型轮次与插件等待；默认每模型请求 180s，整任务 360s。`finish_reason` 为 `tool_calls` 表示继续；兼容网关返回带工具调用的 `stop` 时仍继续执行工具，不视为完成。只有无待执行工具、`stop` 且最终内容非空时才可能完成；缺字段、截断或无效响应均失败，不在失败后暗中换模型。

等待主控工具时也返回当前 `artifacts`（仅新增或变更的文件），供主控检查内容及 SHA-256 后执行测试或其他授权操作。回传测试结果应附被测产物哈希；最终文件若再变更，需要重新验收，不能沿用旧测试结论。

每轮 HTTP 元数据写入本地诊断日志，`agent_step` 的 `ok` 不代表任务完成。请求失败时 `network` 提供过滤后的错误类别、HTTP 状态、耗时和尝试次数；传输错误仅使用允许的短代码。日志不含文件内容、插件参数、答案或原始错误，原始请求 ID 只以哈希保存。

每任务最多 32 条相关插件工具 metadata，由 parent 从实际工具目录挑选注入，不需要使用者手写参数表。模型文字不能增加授权；按原任务权限执行，密钥/登录 cookies/无关私人信息不外发，不可传递结果保留在 parent 侧并返回拒绝或脱敏结果。

并行任务各自独立 `task_id`，不要混用 pending。重试仅限明确 429/500/502/503/504，最多 3 次含首次，尊重 Retry-After；其他模糊失败不重放，不在外层包业务重试循环。

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

默认 6 次模型步骤、12 次工具调用、每次生成 4096 tokens、单次网络请求 180 秒、全任务 360 秒。插件等待时间也计入任务 deadline。任务文本最多 128 KiB，单文件与单工具结果最多 64 KiB，文件合计最多 128 KiB，对话历史最多 256 KiB；UTF-8 字节限制可能比 schema 中字符数限制更严格。最多 16 个同时有效的任务，终态缓存会逐出旧条目。源文件和产物留在当前状态目录下的独立 scratch；这里是路径隔离，不是操作系统沙箱。

连接配置必须含准确的 `models.flash` 和需要时的 `models.pro`，任务开始后固定模型。配置脚本支持 `--pro-model`，Windows 脚本对应 `-ProModel`。客户端不会根据失败自动选择另一模型。已知当前 API 密钥会在输入、响应和中转结果中脱敏；这不替代主控对其他秘密和个人信息的最小化处理。

MCP 请求取消会传入运行时，阻止后续工具副作用；在途模型请求可能继续到已有期限，不能保证服务商停止处理或撤销费用。MCP 进程退出会取消其任务，无法在新进程续接旧任务。终态或超时任务不得通过重新发同一请求隐式重试。
