# dsh-hiddify

Drive a local **Hiddify** installation from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — without opening its desktop GUI. The plugin runs `HiddifyCli.exe` in standalone mode to start and stop the core, hot-switch split-tunnel modes, rotate exit nodes, and search or fetch pages through the proxy.

Part of [Cjrrrrrrrr/dsh-plugins](https://github.com/Cjrrrrrrrr/dsh-plugins). **Windows only.**

## What it solves

| Need | How this plugin does it |
|---|---|
| Drive Hiddify without its GUI | Runs `HiddifyCli.exe build` + `run --full-config` in standalone mode; the desktop app does not need to be running |
| Reach the internet **and** the LAN at once | Private-network `ip_cidr → direct` rules go first in `route.rules`, plus a system-proxy `ProxyOverride` allow-list as a second line of defence |
| Control split-tunnelling | `hiddify_mode` hot-switches between `global` / `cn-bypass` / `direct` |
| Change exit node | `hiddify_nodes` drives the core's Clash REST control plane (`PUT /proxies/select`) — no restart |
| Search from behind the proxy | `hiddify_search` queries several engines concurrently, de-duplicates across them, sends foreign engines through the proxy and domestic ones direct |
| Archive a page's text | `hiddify_fetch` fetches through the proxy and converts the page to plain text |

## Seven tools

| Tool | What it does |
|---|---|
| `hiddify_status` | Core PID, ports, mode, system-proxy state and selected node — plus a **live** three-way connectivity test (foreign / domestic / LAN) |
| `hiddify_start` | Start the core; `mode` / `port` / `systemProxy` / `lanDirect` can be overridden per call |
| `hiddify_stop` | Stop the core (turns the system proxy off too by default, so nothing is left pointing at a dead port) |
| `hiddify_mode` | Hot-switch the split-tunnel mode |
| `hiddify_nodes` | List nodes, select one, return to `auto`, or measure latency |
| `hiddify_search` | Multi-engine search |
| `hiddify_fetch` | Fetch a page's text through the proxy |

## Requirements

- **Windows** (uses `taskkill`, `reg`, `powershell` and `Get-NetRoute`).
- **Hiddify installed**, with a subscription already added in the client. The plugin drives Hiddify's own `HiddifyCli.exe`; it does not ship or replace it.
- **No administrator rights.** The system proxy is written under `HKCU` only.

## Install

```sh
dsh plugin add github:Cjrrrrrrrr/dsh-plugins#path:/packages/dsh-hiddify
```

**Then set two paths.** The defaults point at the author's own install location, and Hiddify has no fixed install path — edit both lines in your profile patch before starting the core:

```yaml
- id: hiddify
  name: '@local/dsh-hiddify'
  config:
    cliPath: 'C:\path\to\Hiddify\HiddifyCli.exe'
    workDir: 'C:\path\to\Hiddify'
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `cliPath` | `E:\Hiddify\HiddifyCli.exe` | Full path to `HiddifyCli.exe` |
| `workDir` | `E:\Hiddify` | Hiddify's working directory |
| `profilePath` | `''` | Subscription config JSON. Empty = the newest `*.json` by mtime under `%APPDATA%\hiddify\hiddify\configs\` |
| `port` | `12399` | Local mixed proxy port (HTTP + SOCKS5 on one port) |
| `clashPort` | `6756` | Clash REST control plane |
| `mode` | `cn-bypass` | `global` / `cn-bypass` / `direct` |
| `lanDirect` | `true` | Put private-network `ip_cidr` rules first in `route.rules` |
| `systemProxy` | `false` | Also switch the Windows system proxy on when starting |
| `dataDir` | `''` | Runtime state and generated configs. Empty = `<plugin>/data` |

## The three split-tunnel modes

| Mode | `route.final` | Rules | Use |
|---|---|---|---|
| `global` | `select` | LAN direct only | Everything foreign through the proxy |
| `cn-bypass` | `select` | LAN direct + `.cn` direct + `geoip-cn`/`geosite-cn` direct | **Recommended:** domestic and LAN direct, foreign through the proxy |
| `direct` | `direct` | Local proxy port only | Temporarily off |

Private networks stay direct in **every** mode, so the LAN never drops:
`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `100.64.0.0/10`, `fc00::/7`, `fe80::/10`, `::1/128`.
Internal suffixes: `localhost`, `.local`, `.lan`, `.internal`, `.home.arpa`, `.arpa` (resolved by the system resolver, `dns-local`).

## Verified behaviour

Measured on Windows on 2026-10-16:

| Item | Result |
|---|---|
| `HiddifyCli.exe build -c <subscription> -o out.json` | Exit code 0, produced a 32-node sing-box config |
| `HiddifyCli.exe run -c out.json --full-config` | Logged `CORE STARTED`, mixed port listening — standalone works |
| Through the proxy: google / duckduckgo / raw.githubusercontent | HTTP 204 / 200 / 200 |
| Direct: baidu / qq | HTTP 200 / 200 (LAN gateway reachable) |
| Core Clash control plane `/proxies` | 40 entries, 32 selector candidates, `PUT` node switch takes effect |
| Node rotation recovering a throttled engine | Bing returned unrelated results on a German node; after switching to Singapore-001, Bing and DuckDuckGo both returned 10/10 relevant hits |
| `-d/--hiddify` settings file | **Some fields are ignored** (only `Region` was read; `BypassLAN`/`MixedPort`/`DNSOptions` were not) — which is why this plugin rewrites the sing-box JSON after `build` instead |
| Desktop app running at the same time | Collides on `16450` (dns-in) and `6756` (clash) — the plugin moves dns-in to `port + 51` and retries once if startup fails |

### Search engines measured through the proxy (2026-10-16)

| Engine | Status | Note |
|---|---|---|
| DuckDuckGo (`html.duckduckgo.com/html/`) | Works | Primary; repeated queries get rate-limited by exit IP (HTTP 202/403) — rotating the node restores it |
| DuckDuckGo Lite | Works | Same, simpler markup |
| Bing (`mkt=zh-CN&ensearch=0`) | Works | `mkt` is required; with only `setlang` it returns an empty result page |
| Baidu | Unstable | 200 when direct, but quickly serves a security-verification page — not used for text extraction by default |
| 360 Search | Unstable | Results are `so.com/link?m=…` redirects; the real URL needs following |
| Sogou | No | Returns a 5.6 KB block page |
| Google | No | Returns a JS wall (`enablejs`), no results |
| Brave / Startpage / Mojeek / Ecosia / Yandex / Yep | No | 429 / 403 / JS wall / no results |
| Public SearXNG instances (20 sampled) | No | Almost all 429 or 403 |
| Marginalia | Partial | Reachable, but very low recall for Chinese queries |

**Conclusion:** the engines that actually work from outside are DuckDuckGo (plus Lite) and Bing, and both rate-limit or poison results by exit IP. The search layer therefore self-checks relevance and automatically rotates the node and retries when the hit count is too low.

## Layout

```
lib/index.js   Cordis plugin — registers the seven tools
lib/core.js    HiddifyCli control layer (find subscription / build / inject split-tunnel / start & stop / Clash API)
lib/net.js     system-proxy switch + three-way connectivity probe
lib/proxy.js   zero-dependency CONNECT-tunnel HTTP client
lib/search.js  multi-engine search + HTML-to-text
test/          end-to-end smoke test, seven-tool mock-host test, and a long-running-core helper
data/          runtime state, generated configs and logs (created at run time)
```

## Known limits

- **Windows only** — depends on `taskkill`, `reg`, `powershell` and `Get-NetRoute`.
- The system proxy is changed under `HKCU` only and needs no administrator rights. **TUN mode is not enabled by this plugin**: it needs administrator rights and the Wintun driver, so `hiddify_start` uses the system proxy plus a local port instead.
- `hiddify_fetch` extracts text only — no JavaScript rendering, so single-page apps yield just their skeleton.
- No Google in the search layer: it is behind a JS wall and no workaround was implemented.

## License

MIT
