# dsh-plugins

Four plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

| Plugin | Category | What it does |
|---|---|---|
| [dsh-scholar](packages/dsh-scholar) | tools | Four model-facing tools for literature work — `paper_search`, `paper_get`, `paper_citations`, `book_search` — over OpenAlex, arXiv, Crossref, Semantic Scholar and PubMed, with open-access PDF resolution through Unpaywall |
| [dsh-sidebar-tidy](packages/dsh-sidebar-tidy) | ui | Keeps the Web sidebar workspace and session list clickable when footer plugins grow tall, by capping and scrolling the plugin-action area |
| [dsh-hiddify](packages/dsh-hiddify) | tools | Drives a local Hiddify installation without its GUI: seven tools to start and stop the core, hot-switch split-tunnel modes, rotate exit nodes, and search or fetch through the proxy |
| [dsh-karing](packages/dsh-karing) | tools | The same for a local Karing installation: seven tools, with mode switching done by repointing the system proxy at one of Karing's three mixed inbounds, so it takes under a second and never restarts the core |

Each is a Cordis plugin that declares a `dsh.bundle` manifest, so it installs with
`dsh plugin add`.

## Install

```sh
dsh plugin add github:Cjrrrrrrrr/dsh-plugins#path:/packages/dsh-scholar
dsh plugin add github:Cjrrrrrrrr/dsh-plugins#path:/packages/dsh-sidebar-tidy
dsh plugin add github:Cjrrrrrrrr/dsh-plugins#path:/packages/dsh-hiddify
dsh plugin add github:Cjrrrrrrrr/dsh-plugins#path:/packages/dsh-karing
```

Each package also works on its own — see its README for configuration and
limitations.

## Requirements

DSH 0.1.0-rc.1 or newer, and Node 20+.

The plugins import `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery`
dynamically and degrade gracefully when they are absent, which is why both are
declared as *optional* peers — installing these plugins never pulls official
packages into your profile.

`dsh-hiddify` and `dsh-karing` are **Windows only** and expect Hiddify or Karing
to be installed already. Neither plugin ships or replaces those programs' own
binaries: they drive the copy you installed, and both need a path to it
configured after installation.

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
packages/dsh-hiddify/
  lib/core.js           HiddifyCli control layer
  lib/net.js            system-proxy switch + three-way connectivity probe
  lib/proxy.js          zero-dependency CONNECT-tunnel HTTP client
  lib/search.js         multi-engine search + HTML-to-text
  lib/index.js          host half — registers the seven tools
  cordis.patch.yml      the bundle row
packages/dsh-karing/
  lib/core.js           Karing control layer
  lib/net.js            system-proxy switch + three-way connectivity probe
  lib/proxy.js          zero-dependency CONNECT-tunnel HTTP client
  lib/search.js         multi-engine search + HTML-to-text
  lib/index.js          host half — registers the seven tools
  tools/embed-kernel.mjs  copies your own karingService.exe into the plugin for port isolation
  cordis.patch.yml      the bundle row
```

## License

MIT — see [LICENSE](LICENSE).
