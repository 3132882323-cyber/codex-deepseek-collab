# 模型能力、思考强度与图片

能力由 `connection.json` 按 `flash` / `pro` 路由声明，模型 ID 与服务商地址仍使用现有配置。以下数值是本地调用策略示例，不能证明某个兼容网关实际具有这些能力。

```json
{
  "default_reasoning_effort": "max",
  "capabilities": {
    "flash": {
      "context_window_tokens": 524288,
      "max_output_tokens": 278528,
      "vision": {
        "enabled": true,
        "max_images": 4,
        "max_image_bytes": 2097152,
        "max_total_image_bytes": 4194304
      }
    },
    "pro": {
      "context_window_tokens": 524288,
      "max_output_tokens": 278528,
      "vision": { "enabled": false }
    }
  }
}
```

将字段合并到自己的连接配置，保留 HTTPS 地址、准确模型 ID、凭据来源等已有字段。不要添加明文密钥。512K 按 524288 tokens、272K 按 278528 tokens 解释；输出上限不能超过同一路由的上下文限制。输入、内部思考与生成内容共同占用模型窗口。本项目没有精确的本地 tokenizer，也不会自动删除历史后重发。

截至 2026-11-02，官方 API 列出 1M 上下文、384K 最大输出，Flash 支持视觉，Pro 未列出视觉支持。这些官方数值不代表兼容网关的限制，应按网关实际能力设置较低上限。[官方模型说明](https://api-docs.deepseek.com/quick_start/pricing/)

## 最高档思考

`default_reasoning_effort: "max"` 为本地默认。单个智能体任务可用 `reasoning_effort` 选择 `none`、`low`、`high` 或 `max`；CLI 对应 `--reasoning-effort max`。最高档发送 `thinking: {"type":"enabled"}` 与 `reasoning_effort: "max"`，`none` 关闭思考。显式 CLI `--thinking disabled` 可覆盖配置默认，同时指定矛盾的参数会在本地拒绝。[请求参数](https://api-docs.deepseek.com/api/create-chat-completion/)

每次默认生成预算仍为 4096 tokens。长输出需要明确提高任务的 `max_output_tokens`，最多达到本地配置上限；增加预算不会保证生成同等数量。思考和最终内容共享生成预算，截断会报告失败，不自动重放。

工具循环会在提供商内部历史中保留 `reasoning_content` 以正确续接，不加入面向主控的答案、插件请求或诊断日志。[思考与工具调用规则](https://api-docs.deepseek.com/guides/thinking_mode/)

## 图片输入

主控明确传入任务所需的图片内容，例如：

```json
{
  "model": "flash",
  "task": "读取图片中的编号，只回答编号。",
  "reasoning_effort": "max",
  "images": ["data:image/png;base64,<替换成真实图片的base64>"],
  "max_output_tokens": 4096
}
```

占位符不能直接调用。支持显式 JPEG、PNG、GIF、WebP data URL，检查 base64、格式与大小；只把图片放入 user 消息。每任务最多 4 张、单张解码后最多 2 MiB、总计最多 4 MiB，配置可以进一步降低。不会根据图片参数自行读磁盘或下载 HTTP URL；原图是否获准外发由主控确认。[官方视觉协议](https://api-docs.deepseek.com/guides/vision/)

Pro 默认处理文本。只有使用者明确验证当前网关的 Pro 路由确实支持图片，才配置 `vision.enabled: true` 和 `vision.verified: true`；配置声明不代替实际验收。不支持图片时本地停止，不自动换模型。

## 本地字节预算

只有配置有效 `context_window_tokens` 的路由启用较大预算。字节限制与 token 窗口是两种限制。

| 项目 | 旧配置 | 配置上下文后 |
| --- | --- | --- |
| 任务 / CLI prompt | 128 KiB | 2 MiB |
| 单个文本文件 | 64 KiB | 2 MiB |
| 文本文件合计 | 128 KiB | 4 MiB |
| 内部历史（含图片编码与思考） | 256 KiB | 16 MiB |
| 单个工具结果 | 64 KiB | 4 MiB |
| 最终答案 | 128 KiB | 2 MiB |
| 提供商响应 | 4 MiB | 16 MiB |

MCP 入站帧最多 16 MiB，出站帧最多 64 MiB。大的工具结果只在 `structuredContent` 中保留完整内容，文本块提示其位置；客户端应优先读取 `structuredContent`。较小结果仍同时提供 JSON 文本。旧配置保留原有字节与 8192 tokens 显式输出上限；未配置默认思考强度时保留关闭思考的行为。

能力和预算不授予新的插件或账户权限。仍由 Codex 核对任务、真实执行已授权插件并验收结果；HTTP 重试、取消、总期限和错误处理规则保持一致。较大窗口和最高档思考不构成速度、成本、质量或长期稳定性保证。
