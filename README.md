# dsh-plugins

Two plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

| Plugin | Category | What it does |
|---|---|---|
| [dsh-scholar](packages/dsh-scholar) | tools | Four model-facing tools for literature work — `paper_search`, `paper_get`, `paper_citations`, `book_search` — over OpenAlex, arXiv, Crossref, Semantic Scholar and PubMed, with open-access PDF resolution through Unpaywall |
| [dsh-sidebar-tidy](packages/dsh-sidebar-tidy) | ui | Keeps the Web sidebar workspace and session list clickable when footer plugins grow tall, by capping and scrolling the plugin-action area |

Both are Cordis plugins that declare a `dsh.bundle` manifest, so they install with
`dsh plugin add`.

## Install

```sh
dsh plugin add github:Cjrrrrrrrr/dsh-plugins#path:/packages/dsh-scholar
dsh plugin add github:Cjrrrrrrrr/dsh-plugins#path:/packages/dsh-sidebar-tidy
```

Each package also works on its own — see its README for configuration and
limitations.

## Requirements

DSH 0.1.0-rc.1 or newer. `dsh-scholar` needs Node 20+; it imports
`@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` dynamically and degrades
gracefully when they are absent, which is why both are declared as *optional*
peers — installing these plugins never pulls official packages into your profile.

## Repository layout

```
packages/dsh-scholar/
  lib/sources.js      data layer — one pure function per source, no host dependency
  lib/index.js        host half — registers the four tools
  cordis.patch.yml    the bundle row
packages/dsh-sidebar-tidy/
  lib/client.js       browser half — the injected CSS
  lib/index.js        host half — an empty placeholder
  cordis.patch.yml    the bundle row
```

## License

MIT — see [LICENSE](LICENSE).
