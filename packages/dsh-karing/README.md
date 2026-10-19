# dsh-karing

Drive a local **Karing** installation from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — without clicking through its GUI. The plugin runs `karingService.exe` in standalone mode, switches split-tunnel behaviour by repointing the system proxy at one of Karing's three permanent mixed inbounds, rotates exit nodes, and searches or fetches pages through the proxy.

Part of [Cjrrrrrrrr/dsh-plugins](https://github.com/Cjrrrrrrrr/dsh-plugins). **Windows only.**

> This is the Karing counterpart of [`dsh-hiddify`](https://github.com/Cjrrrrrrrr/dsh-plugins/tree/main/packages/dsh-hiddify). Karing's split-tunnel model fits "reach the internet and the LAN at the same time" natively, and its mode switch needs no core restart — which is why the two plugins work differently.

## What it solves

| Need | How this plugin does it |
|---|---|
| Drive Karing without its GUI | Runs `karingService.exe run -s <service.json>` in standalone mode; the GUI does not need to be running |
| Reach the internet **and** the LAN at once | Karing's own config already carries `{"ip_is_private": true, "outbound": "direct_out"}`; the plugin additionally injects `.cn`-style domestic domain suffixes as direct |
| Control split-tunnelling | `karing_mode` switches between `rule` / `proxy` / `direct` by **only changing which inbound port the system proxy points at** — no config rebuild, no core restart (under a second) |
| Change exit node | `karing_nodes` drives the Clash REST control plane (`PUT /proxies/urltest_out`) — no restart |
| Search from behind the proxy | `karing_search` queries several engines concurrently and de-duplicates across them; each engine has its own proxy-then-direct fallback |
| Archive a page's text | `karing_fetch` fetches through the proxy and converts the page to plain text |

## Seven tools

| Tool | What it does |
|---|---|
| `karing_status` | GUI and core processes, the three inbound ports, the control plane, system-proxy state, node count — plus a **live** three-way connectivity test (foreign / domestic / LAN) |
| `karing_start` | Start the core. **Reuses a running core first**; only starts standalone when the GUI has not connected one |
| `karing_stop` | Stops **only the core this plugin started** (never the GUI's), turning the system proxy off too by default |
| `karing_mode` | Switch `rule` / `proxy` / `direct` — instant, no core restart |
| `karing_nodes` | List nodes, select one, return to `auto`, or measure latency |
| `karing_search` | Multi-engine search |
| `karing_fetch` | Fetch a page's text through the proxy |

## Why the mode switch is instant

Karing opens **three permanent mixed inbounds** at once and decides the exit by *which port you connect to*:

| Inbound tag | Port (GUI / embedded) | Exit | Meaning |
|---|---|---|---|
| `mixed_in_direct` | 3065 / 3165 | `direct_out` | Fully direct (LAN and domestic) |
| `mixed_in_proxy` | 3066 / 3166 | `urltest_out` | Fully proxied (foreign) |
| `mixed_in_rule` | 3067 / 3167 | rules | Private networks direct, everything else through `urltest` |

So `karing_mode` just points the system proxy at a different port. That is why switching takes well under a second here, versus the 5–25 s a config rebuild and core restart costs in the Hiddify model — and the plugin re-tests all three routes immediately after switching.

The Clash REST control plane listens on `127.0.0.1:3057`; the port and secret are read from `service.json` rather than hard-coded.

## Requirements

- **Windows** (uses `taskkill`, `reg`, `powershell` and `Get-NetRoute`).
- **Karing installed**, with a subscription already configured in the client. The plugin drives Karing's own `karingService.exe`; it does not ship or replace it.
- **No administrator rights.** The system proxy is written under `HKCU` only.

## Install

```sh
dsh plugin add github:Cjrrrrrrrr/dsh-plugins#path:/packages/dsh-karing
```

**Then set `exePath`** in your profile patch — the default points at the author's install location:

```yaml
- id: karing
  name: '@local/dsh-karing'
  config:
    exePath: 'C:\path\to\Karing\karingService.exe'
```

### Optional: embed the kernel for port isolation

By default the plugin runs your installed kernel, which shares ports with the GUI. To give the plugin its own copy and its own ports (3165/3166/3167 plus control plane 3157) so both can run side by side:

```sh
node tools/embed-kernel.mjs            # copies your karingService.exe into <plugin>/runtime/
node tools/embed-kernel.mjs --status   # report only, copies nothing
```

This copies **your own** Karing binary locally. The plugin does not distribute that binary.

| | Before embedding | After embedding |
|---|---|---|
| Kernel | your installed `karingService.exe` | `<plugin>/runtime/karingService.exe` |
| Config | copied from the GUI's `service_core.json` each time | `<plugin>/data/core.json`, owned by the plugin (bootstrapped once) |
| Ports | 3065/3066/3067 — shared with the GUI | 3165/3166/3167 + control 3157 — isolated |
| Runs beside the GUI | port conflict | both run independently |
| GUI killed, upgraded or uninstalled | affected | unaffected |

`karingService.exe` is a statically linked Go binary, so a single-file copy runs on its own without any DLL from the original install directory.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `exePath` | `F:\Karing\karingService.exe` | Full path to `karingService.exe` |
| `appDataDir` | `''` | Karing's data directory. Empty = `%APPDATA%\karing\karing` |
| `dataDir` | `''` | Runtime config copy and core logs. Empty = `<plugin>/data` |
| `mode` | `rule` | `rule` / `proxy` / `direct` |
| `cnBypass` | `true` | Inject `.cn` / `.com.cn` … as direct (no rule-set download needed) |
| `lanDirect` | `true` | Private networks and LAN domains direct, so the LAN never drops |
| `systemProxy` | `false` | Also switch the Windows system proxy on when starting |

## Verified behaviour

Measured on Windows on 2026-10-17 with Karing 1.2.25.2802:

| Item | Result |
|---|---|
| `karingService.exe --help` | Cobra CLI: `run / run2 / check / format / merge / rule-set / geoip / geosite / version` |
| Start command | `karingService.exe run -s <service.json> -D <work_dir> --connected-port 3067` |
| **Pitfall found** | Passing `-s` and `-c` together → `FATAL duplicate inbound tag: mixed_in_direct` (the `core_path` in `service.json` already points at the config, so `-c` merges a second copy) |
| Ports after start | 3057 (control plane) / 3065 / 3066 / 3067 all LISTENING |
| google via 3066 and 3067 | HTTP **204** |
| google via 3065 | Not reachable — by design, that inbound is fully direct |
| Three-way connectivity in `rule` mode | foreign: google 204 / duckduckgo 200 / github-raw 200 · domestic: baidu 200 / tencent 200 · **LAN reachable** |
| `karing_mode` switching proxy ↔ rule | Both under 1 s, all three routes retested green, **core never restarted** |
| `karing_fetch` on a Wikisource page | HTTP 200, 69,534 bytes → 2,933 characters of plain text in 1,076 ms |
| Clash control plane | `/proxies` exposes the `urltest_out` group with 32 candidates; `PUT` node selection takes effect |
| Config isolation | The plugin copies the GUI's `service_core.json` to its own `data/core.json` and injects rules there — it never fights the GUI over the file |
| GUI running at the same time | Starts standalone when no core is up; reuses the running core when one is (no double start, no port grab) |

## Layout

```
lib/index.js   Cordis plugin — registers the seven tools
lib/core.js    Karing control layer (find service.json / copy + inject config / start & stop / Clash API / process discovery)
lib/net.js     system-proxy switch + three-way connectivity probe (pings each default gateway)
lib/proxy.js   zero-dependency CONNECT-tunnel HTTP client (Node's fetch ignores proxies, hence a hand-written one)
lib/search.js  multi-engine search (DuckDuckGo / Bing / Baidu / 360 / Wikisource / Internet Archive / ctext) + HTML-to-text
tools/embed-kernel.mjs  copies your own karingService.exe into <plugin>/runtime/
test/          smoke test, seven-tool mock-host test, focus test, and start/stop helpers
data/          runtime config copy, core logs and runtime.json (created at run time)
```

## Known limits

- **Windows only** — depends on `taskkill`, `reg`, `powershell` and `Get-NetRoute`.
- The system proxy is changed under `HKCU` only and needs no administrator rights. **TUN mode is not enabled** by this plugin.
- `karing_fetch` extracts text only — no JavaScript rendering.
- `cnBypass` injects domain suffixes rather than downloading `geoip-cn` / `geosite-cn` rule sets. That keeps it dependency-free but is coarser than a full geo rule set.
- The kernel binary is **not** bundled. Without running the embed step, the plugin uses your installed kernel and therefore shares its ports with the GUI.

## License

MIT
