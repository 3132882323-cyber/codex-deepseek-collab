# Codex 原生 Flash 接入

## 两种模式

| 模式 | 会话与工具执行 | 模型与文件范围 | 适用情况 |
| --- | --- | --- | --- |
| GPT + Flash MCP | GPT 主控及本项目的外部工作者 runtime | Flash 仅见主控提供的 scratch 文件及工具结果 | GPT 与 Flash 同时分工 |
| 原生 Flash | Codex 自身执行器 | 当前 Codex 会话授权的工作区与工具 | Flash 直接完成编码、终端和 MCP 工具循环 |

原生模式不能保证所有账号插件可用，不提供 OpenAI 的托管搜索、文件检索、图像生成或任意自定义工具协议。Flash 的内置 `web_search` 禁用；已有本地 MCP 工具继续由 Codex 注册并按原权限执行。网关密钥不等于插件登录凭据。

## 配置与运行

现有 `connection.json` 必须只启用 Flash，并准确声明服务商模型 ID、上下文和输出能力；地址需要 HTTPS 且支持 Responses。原生守卫不会自动退回 Chat Completions，也不切换到官方地址、其他密钥或 Pro。此版本的自动认证启动使用 Windows DPAPI 与 PowerShell 7；非 Windows 的 CLI/MCP 功能不受影响，原生自动安装暂不提供。

```powershell
node skills/deepseek-collaboration/scripts/install-native.mjs --codex-bin "C:/Tools/Codex/codex.exe" --planned-output-tokens 32768
codex --profile deepseek-flash
```

`--planned-output-tokens` 为首次明确规划，不是从截断中学习后放大的预算。生成文件位于用户 Codex home：

- `deepseek-flash.config.toml`：仅显式选择的 CLI profile。
- `deepseek-native/models.json`：单 Flash 的本地模型目录。
- `deepseek-native/settings.json`：模型、端口、生成预算及原连接状态目录。
- `deepseek-native/Codex DeepSeek Flash.cmd`：自动启动本地守卫，再运行 Codex CLI。
- `deepseek-native/Enable DeepSeek in Codex.cmd`：切换桌面默认，保存原字段。
- `deepseek-native/Restore GPT in Codex.cmd`：只恢复由开关管理且尚未被另行改动的字段。

桌面切换后需重启 Codex；已运行聊天不会热切换 provider。开关使用 `config/read` 的用户层版本与 `config/batchWrite` 做并发检查，保留其他 provider、MCP、项目和桌面设置；不改 `auth.json`、不创建聊天。恢复时若检测到管理字段被再次修改，将停止，避免覆盖新配置。切换记录包含配置值和本机路径，应留在用户状态目录，不提交到仓库。

## 预算、传输与工具边界

Codex 当前没有生成输出上限的配置项，不能把 `context_window` 或本地工具输出的 `truncation_policy` 当成生成预算。守卫在上游凭据与 HTTP 前检查请求：

- 精确匹配已配置 Flash 模型；拒绝 Pro、其他模型与非 `max` 档。
- 缺省生成预算使用安装时明确规划的数值，典型为 32768；已有过小值直接拒绝，绝不提高已有预算。最低值至少 16384，并受本地策略与模型能力上限约束。
- 推理、答案与工具参数共享每轮生成预算；以上数值不保证足够。通用 CLI/MCP 的 4096 默认保持不变。
- 只向原配置的 HTTPS origin 发送上游密钥，拒绝重定向。Codex 仅得到一个单独的本机 bearer；两者均以当前用户 DPAPI 保护，不写入配置明文。
- 仅对明确 HTTP 429/500/502/503/504 最多尝试 3 次，含首次；单次 180 秒、整个请求操作 360 秒，尊重有界 `Retry-After`。传输故障、超时、坏响应和截断停止，不自动重放。
- Codex 外层 `request_max_retries`、`stream_max_retries` 均为 0，`unbounded_connection_retries` 关闭；禁用 WebSocket 与请求压缩，避免额外重放或非预期协议。

守卫完整读取并校验 Responses 的终态，从最终已验证 `output` 重建唯一一组 SSE 事件。中途的损坏工具增量或与终态不一致的调用不会交给 Codex。重复 item ID、重复 call ID、截断的 JSON 工具参数和纯推理“成功”均拒绝。完整缓冲会增加首次显示内容的等待时间，未收到完整结果时不执行该轮工具。

Codex 的 namespace 中的函数工具会按精确 `(namespace, name)` 映射为稳定的上游别名，并在当前允许的工具表内恢复；函数结果的 `call_id` 与历史不变。未知别名、名称碰撞、不支持的工具类型拒绝，不猜测工具、不新增权限。这只适配已暴露的工具，不保证任何插件都能由当前认证使用。

本机守卫只监听 `127.0.0.1`，需要独立 bearer，拒绝浏览器 Origin、非预期 Host 和路由。健康检查带配置与实现指纹；更新后仅在空闲时替换旧进程，在途任务不被静默切走。诊断只记录时间、HTTP 状态、尝试数、固定错误码和预算，不记录输入、答案、推理原文或工具参数。Codex 自己的会话历史仍按 Codex 的存储设置保存；这与守卫诊断是两回事。

## 验收范围

离线测试覆盖预算与零凭据/零 HTTP 预检、完整性校验、namespace 往返、取消、有限状态重试、认证与浏览器边界、配置并发及恢复。另用本机 Codex 的合成 loopback provider 验证文本成功、断线/半流/超时/截断停止，以及 MCP 工具结果和推理历史的跨轮回传。服务商实测只能证明当次请求行为，不能保证后续可用性。

2026-11-03 本机验收：438 项离线测试通过、2 项因 Windows 符号链接权限跳过；真实 Flash/max 以 32768 每轮预算完成创建文件、终端校验与测试 MCP，三轮均各一次 HTTP。一次先行验收的隔离子进程未完成工具目标；对齐当前环境的执行模式后完成上述验收，没有重放断流或截断的请求。桌面配置开关在合成配置与实际安装的用户配置上均完整往返，恢复后配置对象相等、原密钥密文不变；本机模型目录返回 Flash/max，未测试全部账号插件。

## 官方参考

- [Codex 自定义 provider 配置](https://learn.chatgpt.com/docs/config-file/config-reference)：Responses、命令式认证、重试与模型目录。
- [Codex profiles](https://learn.chatgpt.com/docs/config-file/config-advanced)：独立 profile 文件与 CLI 选择。
- [Codex 子智能体](https://learn.chatgpt.com/docs/agent-configuration/subagents)：自定义 agent 的 provider 继承限制。
- [DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/) 与 [Codex 集成](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)：协议及其兼容范围。网关模型别名必须由使用者自行核对。
