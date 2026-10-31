# dsh-plugins

Four plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

| Plugin | Category | What it does |
|---|---|---|
| [dsh-scholar](packages/dsh-scholar) | tools | Four model-facing tools for literature work — `paper_search`, `paper_get`, `paper_citations`, `book_search` — over OpenAlex, arXiv, Crossref, Semantic Scholar and PubMed, with open-access PDF resolution through Unpaywall |
| [dsh-sidebar-tidy](packages/dsh-sidebar-tidy) | ui | Keeps the Web sidebar workspace and session list clickable when footer plugins grow tall, by capping and scrolling the plugin-action area |
| [dsh-karing](packages/dsh-karing) | tools | The same for a local Karing installation, but with **eight** tools and a different split-tunnel model: Karing keeps three mixed inbounds alive, so switching modes just repoints the system proxy at another port — under a second, and the core is never restarted. Also embeds the kernel into the plugin, self-manages the node subscription, and ships a rate-limit / session / anti-bot layer for the search engines it scrapes |
| [dsh-corpus](packages/dsh-corpus) | tools | Full-text search over a document corpus: a bigram inverted index with simplified↔traditional folding, so **two-character** Chinese queries work (SQLite FTS5 `trigram` needs three and returns nothing for 紫微 or 用神), plus a metadata-vs-content split so index files do not drown out real documents |

Each is a Cordis plugin that declares a `dsh.bundle` manifest, so it installs with
`dsh plugin add`.

## Install

```sh
dsh plugin add github:Cjrrrrrrrr/dsh-plugins#path:/packages/dsh-scholar
dsh plugin add github:Cjrrrrrrrr/dsh-plugins#path:/packages/dsh-sidebar-tidy
dsh plugin add github:Cjrrrrrrrr/dsh-plugins#path:/packages/dsh-karing
dsh plugin add github:Cjrrrrrrrr/dsh-plugins#path:/packages/dsh-corpus
```

Each package also works on its own — see its README for configuration and
limitations.

## Requirements

DSH 0.1.0-rc.1 or newer, and Node 20+.

The plugins import `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery`
dynamically and degrade gracefully when they are absent, which is why both are
declared as *optional* peers — installing these plugins never pulls official
packages into your profile.

`dsh-karing` is **Windows only** and expects Karing to be installed already. It
can either drive the copy you installed, or embed a copy of `karingService.exe`
into `<plugin>/runtime/` via `tools/embed-kernel.mjs` — which is what lets it run
**alongside** the Karing GUI instead of fighting it for ports 3065–3067.

Nothing in this repository ships Karing's binaries. `runtime/` and `data/` are
git-ignored: the kernel copy, the search index and the runtime state are all
generated locally.

## Repository layout

```
packages/dsh-scholar/
  lib/sources.js        data layer — one pure function per source, no host dependency
  lib/index.js          host half — registers the four tools
  cordis.patch.yml      the bundle row
packages/dsh-sidebar-tidy/
  lib/client.js         browser half — the injected CSS
  lib/index.js          host half — an empty placeholder
  cordis.patch.yml      the bundle row
packages/dsh-karing/
  lib/core.js           Karing control layer — service.json discovery, config rewrite, port isolation
  lib/session.js        per-engine session cookies, rate limiting, hourly quota, anti-bot detection
  lib/subscription.js   subscription fetch + hysteria2/vless URI parsing, writes back core.json
  lib/net.js            system-proxy switch + three-way connectivity probe
  lib/proxy.js          zero-dependency CONNECT-tunnel HTTP client
  lib/search.js         multi-engine search + HTML-to-text
  lib/index.js          host half — registers the eight tools
  tools/embed-kernel.mjs      copies your own karingService.exe into the plugin for port isolation
  tools/refresh-subscription.mjs  pull the node subscription without the GUI
  tools/baidu-probe.mjs       delayed recovery probe for rate-limited engines
  tools/collect.mjs           multi-engine crawler with per-topic query sets
  tools/collect-scholar.mjs   academic literature pass (OpenAlex/Crossref)
  tools/fetch-wikisource.mjs  MediaWiki wikitext fetcher for classical texts
  cordis.patch.yml      the bundle row
packages/dsh-corpus/
  lib/store.js          simplified↔traditional folding + bigram index build/load
  lib/search.js         query → posting intersection → verbatim verification → context extraction
  lib/index.js          host half — registers the three tools
  tools/corpus-cli.mjs  index / status / search / read
  cordis.patch.yml      the bundle row
```

## License

MIT — see [LICENSE](LICENSE).
