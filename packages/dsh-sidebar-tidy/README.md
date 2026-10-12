# dsh-sidebar-tidy

Keeps the DSH Web sidebar usable when footer plugins grow tall.

Part of [Cjrrrrrrrr/dsh-plugins](https://github.com/Cjrrrrrrrr/dsh-plugins).

## The problem

The DSH Web sidebar stacks, top to bottom:

```
logoRow (brand)            flex: none
newSession                 flex: none
panelList                  flex: none
regionArea (workspaces,    flex: 1     <- the part you actually click
            sessions)
footArea  (plugin actions) flex: none  <- never shrinks
```

Only plugins that register into `sidebar.footer.action` land in `footArea`, and
because that area is `flex: none` it takes whatever height its contents need and
**never gives any back**. When a footer plugin renders something tall — a pairing
QR code rendered inline at 256×256, for instance — `regionArea` is squeezed down to
a few rows and the workspace and session list becomes hard or impossible to click.

## What this plugin does

One injected `<style>` element with four rule groups, applied to the browser half
only. It changes no plugin behaviour:

| # | Rule | Effect |
|---|---|---|
| 1 | `[class*="_footArea"] { max-height: 34vh; overflow-y: auto }` | The action area scrolls instead of pushing the list off-screen |
| 2 | inline QR images and the bridge's QR element → `min(132px, 100%)` | The QR stays scannable at roughly a quarter of its former height |
| 3 | `[class*="_logoRow"] { height: 44px }`, `[class*="_newSession"] { margin-bottom: 8px }` | Reclaims 16px + 4px at the top |
| 4 | `.cm-foot { height: 26px }`, `.cm-bbox { max-height: 128px; overflow-y: auto }` | Compacts the cost-meter footer and caps its balance box |

## Install

```sh
dsh plugin add github:Cjrrrrrrrr/dsh-plugins#path:/packages/dsh-sidebar-tidy
```

Reload the page. To remove it, uninstall the plugin — the style element goes with
it and nothing else was modified.

## How the selectors are chosen

DSH's own class names are CSS-module hashes like `_2H3hWW_footArea`. The hash
changes between builds; **the suffix does not**, so the rules match with
`[class*="_footArea"]` rather than a fixed hash.

Rules 2 and 4 also name classes owned by the plugins they tune — `.cm-*` from
`dsh-cost-meter` and `KV--Pq_*` from the pairing bridge. Those are stable in the
sense that their authors chose them, not in the sense that anything guarantees them.

## Limits

- This is a **layout patch, not a fix in the plugins that grow**. If a footer plugin
  renders something even taller, rule 1 turns it into a scrollbar rather than
  solving the underlying sizing.
- It targets DSH 0.2's sidebar structure. A DSH release that renames the stable
  suffixes (`_footArea`, `_logoRow`, `_newSession`) would make rules 1 and 3 stop
  matching. Nothing breaks when that happens — the CSS simply no longer applies.
- Rule 4 only has an effect when `dsh-cost-meter` is installed.

## Layout

```
lib/client.js   browser half: the injected CSS (all of the behaviour)
lib/index.js    host half: registers an empty placeholder, does nothing
cordis.patch.yml the bundle row
```

## License

MIT
