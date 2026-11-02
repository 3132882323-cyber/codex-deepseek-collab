# Codex × DeepSeek Collaboration

把可拆分的实质工作交给两个模型共同完成：Codex GPT 统筹工具操作、承担一部分产出并整合验收，DeepSeek 通过文本 API 承担另一部分产出。默认目标是按预计工作量约 50/50 分工。

仓库包含可安装的 Codex skill、无运行时依赖的 Node.js 客户端、配置脚本、协作示例和离线测试。社区项目，与 OpenAI、DeepSeek 无隶属关系。

## 用途与工作方式

本项目适用于可拆分、有明确验收标准、双方各能承担实质性产出的任务，例如批量数据清洗、长文证据抽取、代码候选实现与审查、初稿撰写与结构检查。简单短任务、强实时依赖外部工具的请求、隐私不可脱敏或接口不可用的任务，不应外发。

协作按“预计实际工作量”计，双方目标约 50/50。主控 Codex 及全部 GPT 子智能体合算为 Codex 一方。该比例是规划与验收参考，不是 token 数、调用次数、智能体个数或精确工时，也没有自动配额或调度机制。双方实际产出均计入工作：Codex 的工具操作、整合、修正和验收同样属于其工作量。不得为了凑比例而重复劳动或制造冗余产出。若任务性质导致明显偏离，应在任务说明中记录理由。

标准流程是：Codex 先检查输入并脱敏，构造最小必要上下文；DeepSeek 仅返回文本结果，不授予工具、文件或浏览器权限；Codex 独立验证结果，再应用和回归检查。批量任务先用小样确认格式与质量，再分批发送并保留来源 ID。

本项目是 skill 加 CLI 的协作方式，不是双向 Harness 插件。无速度、费用或质量保证；与 OpenAI、DeepSeek 均无隶属关系。模型文本不构成授权，相同安全边界适用于所有委派。数据会发送到所配置的服务商，使用者需自行授权并遵守相关条款。接口行为与错误处理以 CLI 文档和官方 API 文档为准。

## 快速开始

需要 Node.js 22 或更高版本、可用的 Codex 环境，以及你自己选定服务商的 DeepSeek API 凭据。Windows 加密存储方式还需要 PowerShell 7（`pwsh`）。运行时无需 `npm install`。

```bash
git clone https://github.com/3132882323-cyber/codex-deepseek-collab.git
cd codex-deepseek-collab
npm test
```

下面示例使用官方 OpenAI 格式接口。官方当前 Flash 模型名为 `deepseek-flash`，见 [DeepSeek 模型文档](https://api-docs.deepseek.com/quick_start/pricing/)（核对于 2026-11-02）。兼容网关请替换为你确认的 HTTPS 地址和准确模型 ID；不同服务商的别名可能不同，客户端不会自动换模型。列出模型也不能验证上游模型身份。

### Windows：交互输入并加密存储密钥

在仓库根目录运行：

```powershell
pwsh -NoProfile -File skills/deepseek-collaboration/scripts/configure-windows.ps1 -BaseUrl https://api.deepseek.com -Model deepseek-flash
```

密钥通过隐藏输入读取，以当前 Windows 用户的 DPAPI 加密保存，不放入命令行、示例文件或 Git。配置默认位于 `~/.codex/deepseek-collaboration`；设置了 `CODEX_HOME` 时位于其下。现有连接或凭据默认不覆盖，明确需要替换时使用 `-Force`。DPAPI 文件不能当作跨用户或跨设备的可移植凭据。

### Linux / macOS / Windows：显式环境变量方式

先只生成连接配置，再通过你使用的秘密管理工具给运行客户端的进程注入 `DEEPSEEK_API_KEY`：

```bash
node skills/deepseek-collaboration/scripts/configure.mjs --base-url https://api.deepseek.com --model deepseek-flash --credential-source env
```

配置脚本不读取或保存环境变量中的密钥。环境变量方式是显式选择；DPAPI 解密失败不会回退到环境变量。不要把密钥写入项目文件或带进 shell 历史。Codex 桌面进程与终端可能拥有不同环境，需在实际执行客户端的环境中提供变量。

两个脚本和客户端都支持指定状态目录（Node：`--state-dir PATH`；PowerShell：`-StateDir PATH`）。如使用多个提供商，分别使用不同状态目录，调用时显式选择。

### 检查与调用

```bash
node skills/deepseek-collaboration/scripts/deepseek-client.mjs status
node skills/deepseek-collaboration/scripts/deepseek-client.mjs ask --prompt-file examples/prompt.txt --dry-run
node skills/deepseek-collaboration/scripts/deepseek-client.mjs models
node skills/deepseek-collaboration/scripts/deepseek-client.mjs ask --prompt-file examples/prompt.txt --max-output-tokens 4096 --output result.json
```

`status` 与 `--dry-run` 只做本地检查。`models` 和最后一条 `ask` 会联网，可能产生费用。六行示例只展示协议；小任务直接本地完成即可。输出可能含你发送的材料，应留在自己的工作目录；不要提交到仓库。

接受结果时先检查**本次进程退出码为 0**，再检查 JSON 的 `ok: true`、非空 `answer`、`finish_reason: "stop"`，最后独立验收业务内容。`answer` 若为 JSON 字符串，还需单独解析。不能用旧输出文件中的 `ok: true` 判断本次成功。

## 在 Codex 中使用

将 `skills/deepseek-collaboration` **整个文件夹**复制到目标项目的 `.agents/skills/` 下，形成 `.agents/skills/deepseek-collaboration/SKILL.md`。先检查目标是否已有同名 skill，保留自己的配置。也可以按 [OpenAI 官方 skill 文档](https://learn.chatgpt.com/docs/build-skills)安装到用户级 skill 目录。

在 Codex 中输入：

> 使用 $deepseek-collaboration 完成这个可拆分任务。先按可验收交付规划 Codex GPT 与 DeepSeek 约一半的实际工作量，再调用已经配置的客户端、整合并验证结果。

可选地把 [AGENTS.example.md](AGENTS.example.md) 的规则合并进自己的 `AGENTS.md`。这不会自动授予网络、上传、修改账户或执行模型输出的权限；仍须遵守当前环境与任务约束。安装只提供工作规范，实际分工和工具执行由主控负责。

更多示例见 [批量清洗](examples/batch-cleanup.md) 与 [不同任务的分工](docs/workflows.md)。

## 调用可靠性

默认非流式、thinking 关闭、输出上限 4096 tokens、每次请求 180 秒、请求操作总预算 360 秒。最多尝试 3 次（含首次），只重试明确收到的 HTTP `429/500/502/503/504`，采用有限指数退避和 jitter，并遵守 `Retry-After`；要求的等待超过上限或剩余预算时停止。

超时、传输中断、HTTP 200 的损坏响应、空答案、输出截断均不自动重放；认证、参数、模型错误也停止。不叠加业务重试循环。中转错误可能发生在上游已经处理之后，HTTP 重试也可能额外计费；只允许一次提交时使用 `--max-attempts 1`。

客户端拒绝重定向，只向本地明确配置的 HTTPS origin 发送凭据。诊断文件设计为仅记录操作元数据，日志中的请求 ID 使用哈希；不记录提示词、答案、密钥或原始错误响应。诊断轮转为 best-effort，并发时可能丢失旧记录，不作为账单或完整审计记录。详见 [参数、错误与限制](docs/reliability.md)，完整参数可运行 `--help`。

## 开发与验证

```bash
npm run check
npm test
```

测试只使用合成配置、合成凭据和模拟网络，不应读取真实用户配置或向服务商发出请求。已在 Windows / Node.js 24 本机运行；离线测试验证客户端行为，不能保证特定服务商的可用性或兼容性。

[GitHub Actions 模板](ci/offline-tests.yml)覆盖 Ubuntu / Windows、Node.js 22 / 24。需要启用时，将它放到 `.github/workflows/offline-tests.yml` 后提交；通过 OAuth Git 凭据推送工作流还需 `workflow` 权限。当前仓库保留模板，未启用远端 CI，其他平台组合尚未实测。

## 参考与许可

本项目代码与文档采用 [MIT](LICENSE)。协作规范和客户端由实际使用方案整理，未复制以下项目的实现，也不引入其运行时依赖：

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）：参考其[有限重试策略](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/llm/llm/src/retry-policy.ts)及超时行为；本客户端采用自己的非流式协议和边界。
- [Undici RetryHandler](https://github.com/nodejs/undici/blob/main/docs/docs/api/RetryHandler.md)（MIT）：重试与 `Retry-After` 的行为参考。
- [DeepSeek 官方集成目录](https://github.com/deepseek-ai/awesome-deepseek-integration)（CC0-1.0）及 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)：协议与兼容性参考。
- [DSH Codex Collab](https://github.com/zfu691531-hash/dsh-codex-collab)（MIT）：相关的双向 Harness / Codex 桥接项目，适合需要双方会话互相调用的场景。本仓库采用主控调用文本 API 的方式。

API 服务的使用、费用和数据处理仍以所选服务商条款为准。
