# dsh-karing

单独调用 **Karing** 的 DeepSeek Harness 插件：不依赖 GUI 点按，直接驱动 `karingService.exe` 起内核、
用「连哪个入站端口」切换分流模式（内网/国内直连 ↔ 全代理 ↔ 全直连）、轮换出口节点，
并经代理做多引擎检索与网页抓取。

> 本插件源于一个更早的 Hiddify 实现（已从本仓库移除）。换成 Karing 的原因：Karing 的分流模型天然适配
> 「外网与内网同时可用」，而当时本机 Hiddify 的节点隧道建不起来（详见文末实测记录）。

## 它解决什么问题

| 需求 | 本插件的做法 |
|---|---|
| 单独调用 Karing | 直接跑 `karingService.exe run -s <service.json>`，standalone 模式，不依赖 GUI |
| 外网与内网同时可用 | Karing 配置自带 `{"ip_is_private": true, "outbound": "direct_out"}`；插件再注入 `.cn` 等国内域名直连 |
| 自由控制分流 | `karing_mode` 在 `rule` / `proxy` / `direct` 间切换 —— **只改系统代理指向的入站端口，不重启内核（秒切）** |
| 换节点 | `karing_nodes` 走 Clash REST 控制面（`PUT /proxies/urltest_out`），无需重启 |
| 外网搜索 | `karing_search` 多引擎并发 + 跨引擎去重，每个引擎自带「代理→直连」双通道降级 |
| 抓正文归档 | `karing_fetch` 经代理取页面并转纯文本 |

## 八个工具

| 工具 | 作用 |
|---|---|
| `karing_status` | GUI/内核进程、三个入站端口、控制面、系统代理、节点数 + **实测**外网·国内·内网三路连通性 |
| `karing_start` | 启动内核（**优先复用已运行的**，GUI 没连才 standalone 起） |
| `karing_stop` | 停止**插件自己起的**内核（不碰 GUI 的），默认同时关掉系统代理 |
| `karing_mode` | 切换 `rule` / `proxy` / `direct`（秒切，不重启内核） |
| `karing_nodes` | 列节点 / 切节点 / 回 auto / 测延迟 |
| `karing_subscription` | 查看 / 刷新节点订阅（插件自己拉，不依赖 GUI） |
| `karing_search` | 多引擎检索 |
| `karing_fetch` | 经代理抓正文 |

## Karing 的分流模型（和 Hiddify 不一样，这是关键）

Karing 一次开**三个常驻 mixed 入站**，用「连哪个端口」决定出口：

| 入站 tag | 实测端口 | 出口 | 含义 |
|---|---|---|---|
| `mixed_in_direct` | 3065 | `direct_out` | 全直连（内网/国内） |
| `mixed_in_proxy` | 3066 | `urltest_out` | 全代理（外网） |
| `mixed_in_rule` | 3067 | 规则 | 私有网段 → direct，其余 → urltest |

所以本插件的 `karing_mode` **只是把系统代理指到另一个端口**——不需要重建配置、不需要重启内核，
切换耗时从 Hiddify 版的 5–25 秒降到 <1 秒，而且切换后立即实测三路连通性。

Clash REST 控制面：`127.0.0.1:3057`（端口与 secret 从 `service.json` 读，不写死）。

## 内化：把 Karing 变成插件自带的一部分

插件**完全不依赖外部 Karing 安装**——内核、配置、工作目录、订阅地址全部归插件自己管。

```bash
node tools/embed-kernel.mjs              # 内化：复制内核 + 生成自持配置（换插件专属端口）
node tools/embed-kernel.mjs --status     # 只看状态
node tools/refresh-subscription.mjs      # 刷新订阅（插件自己拉、自己解析、自己写回）
node tools/refresh-subscription.mjs --dry
```

内化覆盖的四处：

| 资产 | 位置 | 说明 |
|---|---|---|
| 内核 | `<插件>/runtime/karingService.exe` | Go 静态链接，单文件复制即可运行（实测） |
| 配置 | `<插件>/data/core.json` | 自持，只在首次从 GUI bootstrap 一次 |
| 工作目录 | `<插件>/data/work/` | 内核自建 cache.db（32KB）；`F:\Karing\data` 那 49MB 是 GUI 的 Flutter 资源，内核不需要 |
| 订阅地址 | `<插件>/data/subscription.json` | 首次从 GUI 采纳，之后插件自持 |

### 订阅自刷新（实测 2026-10-19）

```
订阅：https://<你的机场域名>/coreApi/open/subscribe/...  (来源：插件自持)
✅ HTTP 200 / 11184 字节 ｜ 节点 32 个 ｜ 流量 已用 3.66 GB / 共 100 GB ｜ 到期 2026-11-14
差异：新增 0 ｜ 端点变化 0 ｜ 消失 0 ｜ 解析失败 0
```

- 订阅是 base64 编码的 URI 列表，实测 **32 节点 = 16 hysteria2 + 16 vless(REALITY)**
- 解析器自己写：hysteria2（obfs salamander / alpn h3）、vless（flow xtls-rprx-vision / utls chrome / REALITY pbk+sid）
- 生成的节点与 Karing GUI 自己生成的配置**逐字段一致**（差异 0/0/0 就是证据）
- 刷新后保留 `route` 规则、`direct/block` 出站，重建 `urltest` 与 `dsh_selector` 组
- 响应头 `subscription-userinfo` 直接给出流量与到期日

内化后：

| 项 | 内化前 | 内化后 |
|---|---|---|
| 内核 | 用 `F:\Karing\karingService.exe`（GUI 的） | **`<插件>/runtime/karingService.exe`（插件自带）** |
| 配置 | 每次从 GUI 的 `service_core.json` 复制 | **`<插件>/data/core.json` 自持**（只在首次 bootstrap 一次） |
| 端口 | 3065/3066/3067（和 GUI 抢） | **3165/3166/3167 + 控制面 3157（与 GUI 隔离）** |
| 与 GUI 并存 | ❌ 抢端口 | ✅ 各跑各的 |
| GUI 被杀/升级/卸载 | 受影响 | 不受影响 |

**实测依据**：`karingService.exe` 是 Go 静态链接，**单文件复制后可直接运行**，不依赖 `F:\Karing` 下的任何 DLL
（已用复制品跑通 google 204 / 出口 IP 207.174.28.205）。

## 安装

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
& "$env:APPDATA\DSH Desktop\runtime-commands\generations\*\bin\pnpm.cmd" add --dir . --save-exact "file:E:/deepseekharness/dsh-karing"
# 再把 '@local/dsh-karing' 追加进 package.json 的 dsh.profile.bundles，然后重启 DSH Desktop
```

回滚：从 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 删掉 `@local/dsh-karing`，
重跑 pnpm install（备份见 `package.json.bak-karing-*`）。

## 配置（profile 的 cordis.patch.yml 里可覆盖）

```yaml
- id: karing
  name: '@local/dsh-karing'
  config:
    exePath: 'F:\Karing\karingService.exe'
    appDataDir: ''      # 留空 = %APPDATA%\karing\karing
    dataDir: ''         # 留空 = <插件目录>/data
    mode: 'rule'
    cnBypass: true      # 注入 .cn/.com.cn/... → direct_out
    lanDirect: true     # 私有网段与局域网域名 → direct_out
    systemProxy: false
```

## 实测记录（2026-10-17，本机 F:\Karing，Karing 1.2.25.2802）

| 项 | 结果 |
|---|---|
| `karingService.exe --help` | Cobra CLI：`run / run2 / check / format / merge / rule-set / geoip / geosite / version` |
| 启动命令 | `karingService.exe run -s <service.json> -D <work_dir> --connected-port 3067` |
| **踩坑** | `-s` 与 `-c` 同时传 → `FATAL duplicate inbound tag: mixed_in_direct`（service.json 的 `core_path` 已指向配置，再传 `-c` 等于合并两份） |
| 启动后端口 | 3057（控制面）/ 3065 / 3066 / 3067 全部 LISTENING |
| 经 3066 与 3067 访问 google | HTTP **204** ✅ |
| 经 3065 访问 google | 不通（设计如此，全直连） |
| 三路连通性（rule 模式） | 外网 google 204 / ddg 200 / github-raw 200 ｜ 国内 baidu 200 / tencent 200 ｜ **内网 192.168.192.14 ✅ icmp 1059ms** |
| `karing_mode` 切换 proxy ↔ rule | 均 <1s，切换后三路复测全通，**内核未重启** |
| `karing_fetch` 抓维基文库《烟波钓叟歌》 | HTTP 200，69534 字节 → 2933 字纯文本，1076ms |
| Clash 控制面 | `/proxies` 节点组 `urltest_out`，32 个候选，`PUT` 切节点生效 |
| 配置隔离 | 插件复制 GUI 的 `service_core.json` 到自己的 `data/core.json` 再注入规则，**不与 GUI 抢文件** |
| GUI 同时在跑 | 内核未起时插件 standalone 起；内核已起时直接复用（不重复起、不抢端口） |

### 与 Hiddify 的对照

| | Hiddify 版 | Karing 版 |
|---|---|---|
| 换模式 | 重建配置 + 重启内核（5–25s） | 改系统代理端口（<1s） |
| 内网直连 | 插件注入 `ip_cidr` 私有网段 | 配置自带 `ip_is_private` + 插件补注入 |
| 国内直连 | `geoip-cn/geosite-cn` 远程规则集（需下载） | 注入 `.cn` 等域名后缀（零外部依赖） |
| 控制面 | Clash API 端口随机、每次重启变 | `service.json` 里固定 3057 + secret |
| 本机隧道 | 当时全节点不通 | 通（google 204 / ddg 200） |

## 目录结构

```
dsh-karing/
  lib/index.js     Cordis 插件：注册 7 个工具
  lib/core.js      Karing 控制层（发现 service.json / 复制+注入配置 / 起停 / Clash API / 进程发现）
  lib/net.js       系统代理开关 + 三路连通性实测（含多默认网关逐个 ping）
  lib/proxy.js     零依赖 CONNECT 隧道 HTTP 客户端（Node fetch 不认代理，故手写）
  lib/search.js    多引擎检索（DuckDuckGo / Bing / 百度 / 360 / 维基文库 / Internet Archive / ctext）+ HTML→文本
  tools/collect.mjs     命理资料采集器（多引擎检索 → 抓正文 → 分文件夹归档）
  tools/fetch-wikisource.mjs 维基文库古籍批量抓取（MediaWiki API 取干净 wikitext，按书目分卷）
  tools/clean-wikitext.mjs   wikitext 后处理（表格/标题/链接标记 → 可读文本，离线可跑）
  tools/fetch-urls.mjs  定点补抓指定 URL
  tools/zhihu-cases.mjs 知乎真实案例采集
  tools/index-corpus.mjs 生成资料库索引
  test/smoke.mjs / test/tools.mjs / test/focus.mjs / test/up.mjs / test/down.mjs
  data/            运行时配置副本、内核日志、runtime.json
```

## 实测记录 · 搜索引擎可用性（2026-10-17，经 Karing 代理 127.0.0.1:3067）

| 引擎 | 结果 | 通道 | 相关性 | 结论 |
|---|---|---|---|---|
| **百度** | 200 / 28–29 条 / 1.6–2.0s | 直连 | **26–28/29** | 🥇 中文覆盖最好，默认首选 |
| **360 搜索** | 200 / 6–7 条 / 1.1–1.4s | 直连 | **6–7/7** | 🥈 稳定补充 |
| **维基文库** | 200 / 4–18 条 / 1.8s | 代理 | 4/4（折叠简繁后） | 🥇 古籍原文唯一稳定源 |
| **Internet Archive** | 200 / 8 条 / 1.2s | 代理 | 4/8 | 古籍扫描件，需更长超时 |
| Bing | 200 / 10 条 / 1.0s | 代理 | **0/10**（投毒） | ⚠️ 留作补充，靠相关性判定拦截 |
| DuckDuckGo / Lite | 超时 | 双通道均失败 | — | ❌ 已从默认集移除 |
| Google | 超时 | — | — | ❌ 已从默认集移除 |
| ctext | 200 但解析不出 | — | — | ❌ 已从默认集移除 |
| Marginalia | 200 / 7 条 | 代理 | 0/7 | ⚠️ 中文命中低 |

`DEFAULT_ENGINES = ['baidu','so360','bing','wikisource','archive-org']`

### 两个关键修复

1. **简繁折叠（`S2T` 表 + `foldScript`）**：维基文库/古籍源用**繁体**建页，检索词是简体时，
   相关性判定按字符严格比对会把 15+ 条真实命中全判 0 丢掉。折叠后再比就对上（`奇门遁甲` → `奇門遁甲`）。
2. **相关性自检下沉到检索层**：`relevanceOf()` 用「核心词按序出现」判定，`karing_search` 会直接报
   `X 条（Y 相关）`；当去重后 0 条命中核心词时，明确提示「出口 IP 可能被投毒，建议换节点」。

## 实测记录 · 资料采集（2026-10-17，经 Karing 代理）

| 书目 | 页数 | 字数 | 归档到 |
|---|---:|---:|---|
| 紫微斗數全書（卷一/二/三） | 4 | 84,527 | 01-紫微斗数与八字/紫微斗数 |
| 三命通會（全十卷） | 10 | 207,640 | 01-紫微斗数与八字/八字 |
| 淵海子平 | 1 | 61,195 | 01-紫微斗数与八字/八字 |
| 滴天髓（41 节） | 41 | 14,584 | 01-紫微斗数与八字/八字 |
| 煙波釣叟歌 | 1 | 1,879 | 03-奇门遁甲 |
| 皇極經世（21 卷） | 21 | 269,695 | 04-铁板神数 |
| 皇極經世書（四庫全書本，29 卷） | 29 | 213,806 | 04-铁板神数 |
| 張果星宗（果老星宗） | 1 | 196,482 | 02-七政四余 |
| 星命溯源（四庫全書本） | 7 | 32,833 | 02-七政四余 |
| **合计** | **115** | **1,082,641** | |
| 补充轮（百度+360+Bing，--skip-existing） | — | 新增命中 **260** 条 / 归档 **32** 篇 | 奇门遁甲 +119、铁板神数 +114 最明显 |

**踩坑**：维基文库按 IP 限流，请求间隔 400ms 会返回纯文本 `You are making too many requests`（不是 JSON）；
工具已改成 1.8s 间隔 + 指数退避重试（最多 4 次），改后 41 页的《滴天髓》一次跑完。
另：维基文库用**繁体正名**建页，《果老星宗》实际条目标题是 **張果星宗**，《皇極經世書》正名是 **皇極經世**。


## 百度专项优化与垃圾剔除（2026-10-23）

### 百度为什么打不动 —— 实测链条

| 检查项 | 结果 |
|---|---|
| `www.baidu.com` 首页 | ✅ 200 / 738 KB，能拿到 BAIDUID/BIDUPSID 等 7 个 cookie |
| `www.baidu.com/s` 裸请求 | ❌ 302 → `wappass.baidu.com/.../tuxing_v2.html`（图形验证） |
| 移动端 `m.baidu.com/s` | ❌ 同样 302 |
| `tn=news` 资讯 | ❌ 同样 302 |
| 伪造 BAIDUID | ❌ 无效 |
| **带真实会话 cookie** | ✅ **首次放行，18 条 / 17 条相关** |
| 同会话第 2 次（间隔 30s） | ❌ `socket hang up` |
| 同会话第 3 次 | ❌ `socket hang up` |
| 360 / 搜狗 | ❌ 302 / 000（同期一起被限） |

**结论**：百度对同一 IP 是「**一次一放**」——拿到真实会话后第一次能成功，
之后立即收紧，30 秒、60 秒间隔都无效。这不是 URL 姿势问题，是行为风控。

### 因此做的四处改造（`lib/session.js`）

| 机制 | 说明 |
|---|---|
| **会话** | 先 GET 首页取真实 `BAIDUID/BIDUPSID/PSTM`，搜索时带完整浏览器头（Referer/Sec-Fetch-*），缓存 30 分钟 |
| **限速** | 同引擎最小间隔：百度 45s、360 20s、搜狗 15s、DDG 4s、维基文库 2.5s |
| **配额** | 百度 **1 次/小时**、360 8 次/小时、搜狗 4 次/小时。用尽时**明确报错**，不静默返回空 |
| **风控识别** | 302→wappass、页面含「安全验证」、落地页是验证地址 → 判定风控；连续 2 次才进冷却（首次可能是瞬断），冷却按 10min×2^n 退避，最长 1 小时 |

顺带修了 `proxyFetch` 的一个真 bug：`maxRedirects: 0` 时原本抛错，导致看不到 302 的 `location`，
验证页识别失效。现在原样返回 302 交给调用方判断。

### 垃圾信息剔除

判据：**正文推广词密度 ≥ 10/千字**（免费/在线/排盘/注册/VIP/积分/投稿…），
或标题命中工具站特征且密度 ≥ 5。

**保护规则**（防误删）：
- `古籍-*` 一律不动
- 标题含经典书名（紫微斗数全书/三命通会/滴天髓/渊海子平/果老星宗/皇极经世/邵子神数/铁板神数/烟波钓叟/梅花易数/六壬/太乙/火珠林/卜筮正宗）且正文 ≥ 600 字 → 保留
- 黑名单标题需同时满足密度 ≥ 5，避免「八字案例库」这类被纯标题误杀

**执行方式：不物理删除**，移到 `_待人工复核/`，目录结构与原位置一致，移回即恢复。
本轮剔除 **43 篇**（主库 493 → 450，隔离区 43，总数不变）。



## 命理全域覆盖（2026-10-24）

原有 8 个主题之外，新增 8 个，把「中国命理」补全：

| 目录 | 内容 | 实测成果 |
|---|---|---|
| `08-称骨算命` | 袁天罡称骨、骨重对照、称骨歌 | 9 篇 / 50 命中 |
| `09-邵子神数` | 邵雍河洛理数、邵子神数条文与起数 | 9 篇 / 55 命中 |
| `10-六爻占卜` | 纳甲、增删卜易、卜筮正宗、起卦 | 10 篇 / 58 命中 |
| `11-三式六壬太乙` | 大六壬、太乙神数、金口诀 | 10 篇 / 58 命中 |
| `12-风水堪舆` | 八宅、玄空飞星、阳宅阴宅 | 9 篇 / 50 命中 |
| `13-择日黄历` | 通书、建除十二神、嫁娶择日 | 10 篇 / 29 命中 |
| `14-姓名学` | 五格剖象、三才五格、八字起名 | 7 篇 / 20 命中（含知乎 40 条） |
| `15-相术` | 麻衣神相、面相五官、手相 | 7 篇 / 19 命中 |
| **`16-学术研究`** | **OpenAlex/Crossref 学术文献** | **189 篇** |

### 学术维度（`tools/collect-scholar.mjs`）

之前所有采集只有「古籍 + 网页」，缺学术视角。新增工具用 dsh-scholar 的 OpenAlex/Crossref 数据层，
按 10 个英文主题词检索（拼写注意：学术库中文覆盖低，英文最有效）：

```
八字 / 紫微斗数 / 奇门遁甲 / 风水 / 择日 / 相术 / 命理通论 / 算命实践 / 易学象数 / 姓名学
```

一次拿到 **189 篇**，含 arXiv / ACM / SSRN 的近期研究，例如：
- `Divination by Prompt: LLM-Mediated Xuanxue on Chinese Social Media`（arXiv）
- `Understanding Fortunetelling with Large Language Models in ...`
- `Chinese Eight Signs Prediction`（DOI: 10.3167/sa.2021.650204，期刊论文）
- `"Re-Tell the Fortune so I Can Believe It"`（ACM Proceedings）

每篇带 `doi / venue / year / citations / pdf`，可按 DOI 溯源。

### 百度恢复记录

2026-10-24 09:12，`baidu-probe.mjs` 在 +6h 探测成功：**18 条 / 18 相关 / 1.3s**。
说明风控是**时间衰减**的（6 小时内自然恢复），不是永久封。
但配额仍是 **1 次/小时**（成功一次后立即收紧），别连续打。


## 已知限制

- 仅 Windows（依赖 `taskkill` / `reg` / `powershell` / `Get-NetRoute`）。
- 系统代理只改 `HKCU`（当前用户），不需要管理员。
- **国内直连目前只按域名后缀**（`.cn` 等），没接 `geoip-cn`/`geosite-cn` 远程规则集 —— 想更全可以在 `core.js` 的 `applyRoutingPolicy` 里加 `rule_set`。
- `karing_fetch` 是纯文本抽取，不含 JS 渲染。
- 搜索引擎本身会按出口 IP 限流或投毒（实测 Bing 曾对「铁板神数」返回蓝牙排障文章）——采集器内置相关性自检 + 自动换节点，但引擎可用性不由本插件保证。
