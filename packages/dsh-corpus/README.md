# dsh-corpus

命理语料库**全文检索**。给 `E:\deepseekharness\mingli-corpus` 建 bigram 倒排索引，
两字词就能搜（紫微 / 用神 / 斗數），简繁互通，返回命中片段 + 文件路径 + 出现次数。

## 为什么不用 SQLite FTS5

实测 `node:sqlite` 的 FTS5 `tokenize='trigram'` 对**两字词**返回 0 条：

```
紫微 → 0 条 ｜ 斗數 → 0 条 ｜ 用神 → 0 条 ｜ 元會運世 → 1 条   ← trigram 要 3 字起
```

而中文命理检索大量是两字词。所以自己建 bigram 倒排：

| 指标 | 实测 |
|---|---|
| 语料规模 | 491 篇 / **662.7 万字** |
| 建索引 | **2.3 秒** |
| 唯一 bigram | 583,499 |
| 索引文件 | **13.9 MB** JSON |
| 查询 | **62–437 ms**（含回原文摘上下文） |

## 三个工具

| 工具 | 作用 |
|---|---|
| `corpus_search` | 全文检索：`query` 支持空格分词（AND）、`kinds` 限定板块、`contextChars` 控上下文长度 |
| `corpus_index` | `action=status` 看索引状态；`action=rebuild` 重建（语料有增减后跑） |
| `corpus_read` | 按文件名/相对路径读取某篇片段，`at` 从指定字符继续 |

## 用法

```
corpus_index  action=status
corpus_search query="紫微 用神" kinds=["古籍"] limit=5
corpus_search query="傷官格"
corpus_read   name="張果星宗" chars=2000
```

命令行等价物：

```bash
cd E:\deepseekharness\dsh-corpus
node tools/corpus-cli.mjs index                      # 重建
node tools/corpus-cli.mjs status                     # 状态
node tools/corpus-cli.mjs search "紫微 用神" --limit 10
node tools/corpus-cli.mjs read --name 張果星宗 --chars 2000
```

## 关键设计

### 1. bigram 倒排（两字起可搜）
查询 → 折叠 → 切 bigram → 倒排求交得候选文档 → **回原文精确复核**（bigram 只是粗筛）→ 按出现次数排序。

### 2. 简繁折叠
索引和查询都过一遍 `S2T` 表（折到繁体一侧），所以：
- 搜「紫微斗数」能命中「紫微斗數」
- 搜「伤官格」能命中「傷官格」

### 3. 板块分类与默认过滤
| kind | 来源 | 默认 |
|---|---|---|
| `古籍` | `古籍-*.md` | ✅ 参与 |
| `网页正文` | 采集的网页 | ✅ 参与 |
| `案例` | `知乎案例-*.md`、文件名含案例/命例/断验 | ✅ 参与 |
| `命中记录` | `_检索结果.jsonl`、`_知乎案例.jsonl` | ❌ 默认排除 |
| `索引` | `00-索引/采集清单.md` | ❌ 默认排除 |

**为什么要排除后两类**：它们是元数据，动辄几百次命中（`_归档清单.jsonl` 里「紫微斗数」出现 754 次），
会把真正的正文档挤掉。要看它们就显式传 `kinds=["命中记录"]`。

### 4. 上下文取自正文
跳过 YAML front-matter，并且上下文窗口的起点夹在正文起始位置之后——
否则每段摘录都会从 `title:` / `url:` 那几行开始，看不出内容。

## 实测检索样例

```
corpus_search "傷官格"
→ 2 篇
  1. [案例] 14-歷史命造案例庫 — 29 次
  2. [古籍] 古籍-三命通會 (四庫全書本)_全覽.md — 18 次
     「…辛生三月是印格喜木火亦有傷官格論稍不忌水餘忌如之…」

corpus_search "紫微 用神"
→ 57 篇（AND）
```

## 已知限制

- 索引 13.9 MB 常驻内存（首次调用加载一次）
- bigram 对**单字**查询退化为全表扫描（罕见，可接受）
- 排序只按出现次数，没有 TF-IDF/BM25——古籍里单字重复多，长文档容易排前面
- 语料库文件有增减后需要 `corpus_index action=rebuild`
- PDF（260 个扫描本）不在索引里——它们是纯图片，无文本层

## 目录

```
dsh-corpus/
  lib/store.js    S2T 折叠表 + bigram 索引构建/存取
  lib/search.js   检索 + 原文复核 + 上下文摘录
  lib/index.js    Cordis 插件：注册 3 个工具
  tools/corpus-cli.mjs  命令行
  data/index.json       索引（13.9 MB）
```
