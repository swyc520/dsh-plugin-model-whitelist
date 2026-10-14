# dsh-plugin-model-whitelist

[简体中文](README.md) | **English**

A model **whitelist** for the DeepSeek Harness (dsh) model selector: tick the models
you want under **Settings → Models**, and everything you leave unticked disappears
from the composer's model menu.

- **Nothing is hidden by default.** An empty whitelist behaves exactly like stock —
  installing the plugin changes nothing until you use it.
- **Reversible at any time.** Hidden models stay listed in the settings panel; tick
  them back to restore them.
- **The official UI is never shadowed.** The model menu, the reasoning-effort
  submenu, keyboard handling and failure rows all remain exactly as shipped.

---

## What it is for

Once a few providers are connected, the model menu gets long: several groups, dozens
of models, plus region-limited or permanently unavailable entries mixed in. Switching
models turns into scrolling and hunting.

This plugin lets you put away what you do not use and keep the handful you do.

It does **not** disable or uninstall models. Hiding only affects what the selector
menu shows; the models themselves, the provider configuration and the invocation path
are untouched.

## Install

### Command line (plain `dsh web`)

```bash
dsh plugin --profile web add @swyc520/dsh-plugin-model-whitelist
dsh --profile web --dump-config   # confirm the plugin row entered the config tree
```

Restart `dsh web` once after installing.

### Desktop / DSHEAC AIO

The desktop profile belongs exclusively to the Electron application, so the
`dsh plugin add` CLI cannot write to it. Install through the in-app plugin manager.
For a manual install, note that the desktop profile gate **rejects `link:`
dependencies and directory junctions** — real directories only.

## Usage

1. Open **Settings → Models**.
2. Scroll to the bottom and find the **Model visibility** panel.
3. Untick the models you do not want to see.

The panel header shows `Showing N/M`; each provider gets a card whose title carries
the number hidden in that group. Three buttons: **Show all**, **Hide all**, **Reload**.

Changes take effect immediately — no refresh needed.

> If the panel says no catalog has been read yet, open the model selector once. The
> catalog is loaded on demand by the official model-selection plugin, and this plugin
> reads that same catalog.

## How it works

This section explains why the plugin is built the way it is, and when it degrades.

### The whitelist lives in browser local storage

Key `dsh-model-whitelist/v1`, scoped to the browser and the Web address. It is **not**
written to `settings.yaml`, does not modify any provider configuration, and is not
uploaded anywhere. Clearing site data clears the whitelist with it.

It persists the *hidden* set rather than the *shown* set, so a model the user has
never seen — a new release, a newly connected provider — is visible by default.
Persisting the shown set would silently hide every new model, which reads as a bug.

### The filter is a projection, not a shadow

dsh documents a `replaceRisk` for every UI extension point (slot). The official model
selector sits in `conversation.input.model`, rated **`shadows-shipped-ui`**:
registering there *replaces* the official control and takes over its menu, its
reasoning-effort submenu, its keyboard handling and its failure rows. That is a poor
trade for a display preference.

The path the official selector uses to read the catalog is public:

```
ctx.modelDirectories.catalog.store.getSnapshot()
  -> { value: { groups: [{ id, name, models: [...] }], default, failures },
       status, error }
```

`createSnapshotStore` returns a plain object (`{ getSnapshot, subscribe, update, set }`)
whose `getSnapshot` is an ordinary method. This plugin therefore **wraps that one
method** and returns a projected snapshot:

- the official component renders its **own** UI as before, over a list that no longer
  contains the hidden models;
- the real store is never written to, and `subscribe` still reports the real changes,
  so both catalog updates and whitelist edits trigger a re-render;
- the projection is idempotent and total: it copies only the `groups` array, and only
  when something is actually hidden.

The original method is restored when the plugin is disposed.

### It therefore cannot break startup

A client plugin that throws during activation makes the host abort with
`web boot: 1 entry did not activate`. Two things prevent that here:

1. the plugin exports the `inject` array cordis needs (`['locale', 'slots']`), so the
   host waits for its dependencies before calling `apply`;
2. every fallible read — `require` of the official primitives, service lookup, local
   storage access, snapshot projection — is wrapped and degrades: no primitives falls
   back to plain elements, no service shows an empty state, a blocked storage read is
   treated as an empty whitelist, and a projection error returns the unfiltered
   snapshot.

The worst case is "nothing is hidden", never "the app will not open".

## Compatibility

Verified on **dsh `0.2.0-rc.2`** (desktop @deepseek-ai/dsh-desktop 0.2.0-rc.2,
Electron 44, Node 24.18.1): the panel appears, unticking a model removes it from the
selector menu immediately, and ticking it back restores it.

The plugin depends on two public surfaces: the snapshot shape of
`ctx.modelDirectories.catalog.store`, and the `settings.models.footer` slot — the
latter documented by dsh's slot contract and rated `replaceRisk: none`. If either
changes shape in a future release, the plugin degrades to an empty panel or to no
filtering; it does not interrupt startup.

Not verified against the 0.1.x line.

## Known limitations

- **The whitelist only affects what the selector menu shows.** A model you already
  selected keeps working; hiding the model currently in use does not disturb the
  running conversation.
- The panel reads the catalog when it opens and subscribes to later changes. If a
  provider's model list loads lazily, trigger a load once (open the model selector)
  before the models appear in the panel.
- The whitelist is scoped to the browser and address. Changing the port, switching
  browsers, or clearing site data loses it.
- There is no per-provider bulk action beyond Show all / Hide all.

## Development

```bash
node scripts/verify-client.mjs
```

The script loads `lib/client.js` through a stubbed module table and a small renderer,
then asserts that the factory and export shape are correct, that the `inject` array is
present, that the slot registration targets `settings.models.footer`, and that the
**projection really does remove hidden models** — while covering the degraded paths:
empty and malformed snapshots, a missing service, and refused local storage.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
