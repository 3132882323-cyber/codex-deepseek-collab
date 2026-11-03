# 共享输出预算策略

## 协议边界

在 DeepSeek 推理模式下，每一步生成中的思考内容、最终回答和工具调用参数共享同一个输出预算。旧模式未指定时为 4096；显式启用 `long_task_policy` 且选择 `output_tokens:"route_max"` 后，未指定时使用本机声明的所选路由上限，不设累计 token 配额。两种模式都优先使用调用方的显式 `max_output_tokens`（CLI 为 `--max-output-tokens`），受路由和上下文限制；较大的上限不要求模型生成同等数量。详见[长任务模式](long-tasks.md)。

这里的“最小输出预算”是发起任务前的本地准入条件，不替代路由检查、模型能力上限检查或实际 HTTP 响应检查。

## 配置方式

仅在确实需要约束 `max` 推理任务时配置：

将下列 JSON 片段合并进已有 `connection.json`，保留连接、凭据来源和能力配置：

```json
{
  "output_budget_policy": {
    "flash": {
      "max_reasoning_min_output_tokens": 16384
    }
  }
}
```

只有 Flash 路由的输出能力上限至少为 16384 时，才应配置上述最小值。若路由能力上限低于 16384，不应设置该策略，也不应指望系统自动抬高预算。客户端会校验已配置的路由与输出能力上限，并在读取凭据和联网前执行检查。

上面的配置只约束 Flash，不自动启用或使用 Pro；`max` 任务仍应保持 `reasoning_effort: "max"`，不要为了规避预算检查而自动降级推理强度。最小预算只对有效的 `max` 生效，`none`、`low`、`high` 均不受其约束；只设置 `thinking: enabled` 而未指定推理档位，也不凭空判为 `max`。

## 纯函数接口

```text
assessOutputBudget({
  reasoningEffort,
  maxOutputTokens,
  minMaxReasoningOutputTokens
})
```

`reasoningEffort` 只能是 `none`、`low`、`high` 或 `max`。`maxOutputTokens` 必须是 32 到 393216 之间的安全整数。`minMaxReasoningOutputTokens` 可省略、传 `undefined` 或 `null` 以停用策略；否则也必须是 32 到 393216 之间的安全整数。无效值会以固定的 `RangeError` 消息拒绝，不进行字符串转换或输入拼接。

返回值固定包含：

| 字段 | 含义 |
| --- | --- |
| `ok` | 请求预算是否满足策略 |
| `error_code` | 通过时为 `null`，不足时为 `output_budget_insufficient` |
| `requested_output_tokens` | 原样返回请求的输出预算 |
| `minimum_output_tokens` | `max` 且配置策略时返回配置的最小值，否则为 `null` |
| `reasoning_effort` | 原样返回推理强度 |
| `reasoning_shares_output_budget` | 固定为 `true`，表示共享输出预算 |

函数不会设置默认生成值、增加请求的 token 数、选择其他模型或重新提交请求。若本地判断为不足，应直接拒绝，不应把拒绝改写成更大的请求。

例如，显式设置为 16384 且策略最小值也是 16384 时，请求通过；旧模式沿用 4096 会本地拒绝。长模式明确采用 route_max 时在首次请求前解析出路由上限，再检查最低预算；最低预算策略本身不放大数值，也不扩容重发截断。

## 任务规划示例

| 场景 | 显式 `reasoningEffort` | 显式 `maxOutputTokens` | 策略最小值 | 说明 |
| --- | --- | --- | --- | --- |
| 首次的小型、隔离 `max` 任务 | `max` | 16384 | 16384 | 仅作为该任务明确写出的初始预算 |
| 代码或多文件 `max` 任务 | `max` | 32768 | 16384 | 作为规划起点，仍由调用方显式设置 |

16384 和 32768 只是规划示例，不是成功保证，也不是按任务规模、文件数量或历史结果自动缩放的规则。每个任务都应根据路由能力上限和实际输入显式决定预算。

## 本地拒绝与失败处理

预算检查应在读取凭据和发出 HTTP 请求之前完成。对于预算过小的请求，应在本地拒绝并返回明确错误，避免把已知不足的预算发送到远端。

实际截断不能通过放大预算自动重发。超时和传输失败仅按用户授权的客户端白名单、共享尝试及时间额度有限重试，预算策略不负责重发，不在外层重复 start/ask。

## 已知脱敏诊断

一条已知的脱敏诊断事实是：`max` 且请求输出上限为 4096 的任务返回 HTTP 200、`finish_reason=length`，`completion_tokens=4096`、`reasoning_tokens=4096`，已提交产物为零（zero committed artifacts）。该记录仅说明极小预算可能在产生可提交产物前耗尽，不用于推断一般成功率、速度、成本或可用性。

## 协议参考

- [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)

以上链接仅作为协议语义参考，不构成性能、成本或可用性保证。
