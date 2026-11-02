# 客户端参数与边界

## 本地状态

默认目录：`${CODEX_HOME:-~/.codex}/deepseek-collaboration`。所有命令可用 `--state-dir PATH` 覆盖；PowerShell 配置脚本对应 `-StateDir PATH`。

| 文件 | 用途 |
| --- | --- |
| `connection.json` | 明确指定 HTTPS `base_url`、相同 origin 的 `allowed_origin`、`openai` 协议、准确模型及 `flash` 别名、凭据来源 |
| `credential.dpapi` | 仅 Windows DPAPI 方式使用的密文，不能公开或跨设备复用 |
| `diagnostics.jsonl` | 最多约 512 KiB 的安全操作元数据，轮转保留一份 previous 文件 |

示例见 [connection.example.json](../skills/deepseek-collaboration/references/connection.example.json)。`credential_source` 为 `env` 时仅使用 `DEEPSEEK_API_KEY`；缺省或 `dpapi` 时仅使用 DPAPI，二者不相互回退。配置中不要加入明文密钥。只支持模型名以 `deepseek` 开头的提供商别名，不将此检查视为上游身份认证。

`allowed_origin` 是本地配置的目标确认，不是独立信任证明。只使用你信任并授权的服务商，保护状态目录免受非授权修改。客户端不验证提供商的存储、路由或模型真实性。

## 命令

```text
deepseek-client.mjs [--state-dir PATH] status
deepseek-client.mjs [--state-dir PATH] models
deepseek-client.mjs [--state-dir PATH] ask --prompt-file PATH [options]
```

`status` 不解密 DPAPI、不联网。`ask --dry-run` 校验配置与输入，不解密 DPAPI、不联网、不写输出。`models` 做一次 GET，不应用 ask 的重试选项。`configured: true` 仅表示本地信息就绪；模型列表包含目标也不等于生成请求可用。

| ask 参数 | 默认值 / 取值 |
| --- | --- |
| `--model` | 默认配置的模型；可填别名 `flash` |
| `--thinking` | `disabled` / `enabled`，默认 `disabled` |
| `--max-output-tokens` | 默认 4096，范围 32–8192 |
| `--timeout-ms` | 默认 180000，单次包括完整响应体的期限 |
| `--total-timeout-ms` | 默认 360000，请求及退避总预算，最多 900000 |
| `--max-attempts` | 默认 3，范围 1–3，包含首次 |
| `--retry-base-ms` | 默认 1000，范围 1–10000 |
| `--retry-max-ms` | 默认 10000，范围 1–60000，不能小于 base |
| `--output` | 可选，原子写入本次结果 JSON；父目录需已存在 |
| `--dry-run` | 仅校验，不写 output |

输入为 UTF-8 文本，最大 128 KiB；响应体最大 4 MiB。只发单条 user 消息，固定 `stream: false`，不提供工具调用执行器、会话持久化、图像输入或流式输出。thinking 开启时，推理和最终内容共享生成限制；只有最终 `message.content` 作为答案。

## 完整性与失败

先要求本次进程退出码为 0，然后读取本次 JSON。成功生成需 `ok: true`、`finish_reason: "stop"`、非空 `answer`。这只证明协议完整，事实、代码或业务结论仍需独立检查。

仅明确收到的 HTTP 429/500/502/503/504 可重试。尊重 `Retry-After` 秒数或日期，超过等待上限或剩余总预算则停止，不提前请求。网络中断、超时、损坏响应与输出截断不会自动重放。需要重新发起时先核实错误与任务状态，不套重试循环。任何重试都不保证服务商恰好只处理一次。

结果包含 attempts、elapsed_ms、http_status、error_category、过滤后的 request_id 和 attempt_history；传输错误仅返回允许的短代码。诊断日志保存相同类别的元数据，请求 ID 在写日志前转为哈希。不保存原始错误消息、响应头、错误正文、提示词或答案。远端返回的模型、用量和请求标识仍属不可信数据。

安全校验后的输出目标会记录当前本地失败；非法参数、不安全目标或无法写入的路径可能只能返回非零退出码与 stderr JSON。读取旧输出时尤其需要检查本次退出码。输出不能覆盖提示词、配置、凭据或诊断日志，也不能通过符号链接或硬链接绕过这些检查。

日志写入失败不把已完成的 API 请求标记成失败；并发轮转可能丢失历史记录。客户端只按需运行，没有常驻健康监控、服务商自动切换、失败自动换模型或精确成本统计。
