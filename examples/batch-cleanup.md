# 六行数据清洗/分类：可复制指令与CSV

## 先说明适用范围

下面的六行只是**协议演示**，用于确认输入、输出、issues 与验收格式。实际只有六行时应直接本地处理（例如用脚本或手工改），**无需调用外部模型**。真实大批量数据应先做小样（如几十行）确认规则和提示词，再分批处理，避免把 API 用于极小的可本地完成的任务。

分工建议：DeepSeek 负责按给定规则生产清洗分类后的完整数据与异常清单（issues）；Codex 负责输入校验、提取最小文本、控制调用预算、应用结果，并按 ID/顺序/类别/缺失值规则验收。大批量时两侧工作量预计可接近 50/50，这不精确测量，也不要为凑比例重复处理。DeepSeek 不能自行读取文件或联网；Codex 必须把源数据内容嵌入提示词（`--prompt-file` 指向保存好的 UTF-8 文本）。

## 规则（复制给 Codex）

1. 保留 ID 与原顺序；ID 输出整数。
2. name：仅去首尾空白；对 ASCII 英文单词做 Title Case（apple->Apple，PEN->Pen，Desk Lamp 不变）。非 ASCII 文本不得翻译或替换。空名称输出 null。
3. category：去空白后不分大小写精确映射：fruit=>Fruit，furniture=>Furniture，office=>Office，stationery=>Stationery。未知输出 null，并在 issues 记录 `{id, field:"category", code:"unknown_category"}`。
4. 名称为空时输出 null，并在 issues 记录 `{id, field:"name", code:"missing_value"}`。
5. 严格要求 DeepSeek 返回严格 JSON 对象 `{rows:[{id,name,category}],issues:[{id,field,code}]}`，不得返回自造 `ok:true` 之类字段作为业务验收凭证。
6. 所有 6 行都必须存在。

## CSV 输入（保存为 data.csv）

```csv
ID,name,category
1,  蓝莓  , fruit
2,Desk Lamp,Office
3,  apple,FRUIT
4,chair , furniture
5,   ,office
6,PEN, Stationery
```

## 预期输出文件（examples/expected-rows.json）

```json
{
  "rows": [
    {"id": 1, "name": "蓝莓", "category": "Fruit"},
    {"id": 2, "name": "Desk Lamp", "category": "Office"},
    {"id": 3, "name": "Apple", "category": "Fruit"},
    {"id": 4, "name": "Chair", "category": "Furniture"},
    {"id": 5, "name": null, "category": "Office"},
    {"id": 6, "name": "Pen", "category": "Stationery"}
  ],
  "issues": [
    {"id": 5, "field": "name", "code": "missing_value"}
  ]
}
```

## 客户端命令

```bash
# 在仓库根目录运行；先配置你自己的接口与凭据。
node skills/deepseek-collaboration/scripts/deepseek-client.mjs ask --prompt-file examples/prompt.txt --output result.json

# 仅在上一条命令本次退出码为 0 时继续：
node examples/validate-result.mjs result.json
```

## Codex 静态验收要点

- 先检查客户端本次退出码，再解析 result.json：要求 `ok: true`、非空 `answer`、`finish_reason: "stop"`。然后对 `answer` 单独做 JSON.parse，业务对象仅有 rows、issues 两个键，与预期文件严格比对。
- rows 长度必须为 6；id 依次为 1..6 且为整数；不得重排。
- name 非空时不得含首尾空白；ASCII 英文单词符合 Title Case；非 ASCII（蓝莓）不得被翻译/替换。
- 空 name 为 null，且 issues 含 id=5、field=name、code=missing_value。
- category 属于允许集合或 null；未知类别时输出 null 且 issues 含 unknown_category。
- 不以 `ok:true` 等自造字段作为通过依据；以 rows/issues 与规则比对为准。
