# 00 · arXiv / 资料抓取流程(已验证,供 subagent 复用)

本文件是调研的**统一取数流程**。所有 subagent 必须按此流程抓取一手资料,并把
"验证台账"写进各自文档。禁止凭记忆编造引用;每条引用都要标记 `verified-real` /
`wrong-id` / `unverifiable`。

## 0. 结论(2026-10-05 实测)

用**本地 agent-gavel MCP 浏览器**访问 arXiv 可行,且能拿到:
- 摘要页结构化字段(标题/作者/日期/摘要);
- 全文 HTML(`https://arxiv.org/html/<id>` 或 `/html/<id>vN`)约 10 万字符;
- 需要时也可访问 GitHub README / raw 文件。

已实测:
- `https://arxiv.org/abs/2305.16291` → `div#abs` 文本与结构化字段均正确。
- `https://arxiv.org/html/2407.15325v3` → `document.body.innerText.length ≈ 111954`。

## 1. 工具

agent-gavel MCP 工具(名称以 `agent-gavel_` 前缀):
- `browser_status` / `session_create(mode="ephemeral")` / `page_open`
- `page_navigate(page_id, url, wait_until="domcontentloaded", wait_s=3)`
- `page_text(page_id, selector, mode="text", max_chars=N)`
- `page_read(page_id, page_features={name: "() => ..."})`  ← 结构化抽取,首选
- `page_list` / `page_close`

若某 subagent 环境没有 agent-gavel 工具,回退:`curl -sL`(见 §5)。

## 2. 摘要页(首选,用于台账)

```
page_navigate(page_id, "https://arxiv.org/abs/<ID>")
page_read(page_id, page_features={
  "title":    "() => (document.querySelector('h1.title')||{}).innerText",
  "authors":  "() => (document.querySelector('div.authors')||{}).innerText",
  "abstract": "() => (document.querySelector('blockquote.abstract')||{}).innerText",
  "date":     "() => (document.querySelector('div.dateline')||{}).innerText"
})
```

要点:
- 若返回标题是 "Page not found" 或结构为空 → 该 id 不存在,记 `wrong-id`。
- 一个 page 可连续导航多篇,无需重开;复用同一 `page_id` 最省资源。

## 3. 全文 HTML(用于细读方法与实验)

```
page_navigate(page_id, "https://arxiv.org/html/<ID>v<N>")
page_text(page_id, mode="text", max_chars=120000)   # 或分段 selector
```

- 版本号 `vN` 可省;有的老论文没有 HTML 版(此时只能读 PDF 摘要+正文搜索)。
- 大文本建议按小节读,避免一次回传过大;需要时用 selector 精确定位
  (arXiv HTML 正文容器常见为 `main` / `article` / `section.ltx_section`)。
- 找不到 HTML 版时,记 `unverifiable(full-text)`,只依据摘要,不要臆测方法细节。

## 4. 保存到本地

- 每篇保存摘要到 `docs/research/sources/<slug>-abstract.txt`(纯文本,含 id/标题/日期/摘要)。
- 关键方法段落**应**保存到 `docs/research/sources/<slug>-notes.txt`;全文**应**保存为 `<slug>-fulltext.txt`。
- **现状限制(须诚实标注)**:`sources/` 目前**多数只有摘要**,除 `sources/apis/` 外**没有 `-notes.txt`/`-fulltext.txt`**。
  因此凡"摘要之外"的论断(方法细节、实现范围、实验条件)**一律标 `待全文核查`**,不得当已证事实。
- slug 用小写连字符,如 `voyager`, `deps`, `odyssey`, `embodiedskills`。

## 5. 回退方案(无 agent-gavel 工具时)

- arXiv 元数据 API:`curl -sL "http://export.arxiv.org/api/query?id_list=<ID>"`(Atom XML)。
- 注意:`id_list` 里**不要放伪造/通配 id**(如 `2603.xxxxx`),会整批 400。
- GitHub:`curl -sL https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>`。

## 6. 台账格式(每篇文档末尾必附)

| arXiv id | 标题 | 年份 | 状态 | 抓取方式 | 备注 |
|---|---|---|---|---|---|
| 2305.16291 | Voyager | 2023 | verified-real | agent-gavel abs | 全文 html 可读 |

状态取值:`verified-real` / `wrong-id` / `unverifiable`(注明原因)。

## 7. 纪律

1. **先验证再写**:凡没在本次抓到原文的论断,标注"未验证",不得写成事实。
2. **区分 claim / implemented / unclear**(尤其 GitHub 项目,README 宣传 ≠ 代码实现)。
3. **引用数字必须来自原文**;否则写"not verified"。
4. 方法细节优先读全文;只读摘要时明确说明。
