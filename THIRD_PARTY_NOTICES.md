# Third-party notices

## DeepSeek Harness (`dsh`)

This plugin is an independent add-on for DeepSeek Harness and is not affiliated with
or endorsed by DeepSeek.

- Project: https://github.com/deepseek-ai/deepseek-harness
- License: MIT

### What this plugin uses from dsh

The plugin runs inside the harness and talks to documented public surfaces only. It
**does not bundle, vendor, or copy** any dsh source file.

| Surface | Kind | Use |
| --- | --- | --- |
| `settings.models.footer` | client slot, documented in dsh's slot contract with `replaceRisk: none` | hosts the "Model visibility" panel |
| `ctx.modelDirectories.catalog.store` | service field published by `@deepseek-ai/dsh-client-ui-model-selection` | read the model catalog; `getSnapshot` is wrapped to project it |
| `@deepseek-ai/dsh-client-ui-primitives` | module-table package | resolved at runtime for `Button`; the panel falls back to plain elements when unavailable |
| `@deepseek-ai/cordis` | peer runtime | plugin lifecycle (`apply`, `inject`), `locale` dictionaries, `slots` |

### Interface conventions

The row identifier format `${providerId}/${modelId}` and the selection shape
`{ provider, model, reasoningEffort? }` follow the conventions the official
model-selection plugin uses, so that this plugin and the harness agree about what a
row means. These are interface facts, not copied implementation.

This plugin's implementation — the catalog projection, the panel, the storage schema —
is original to this project.

## Dependencies

None at runtime. The plugin has no `dependencies` and installs no packages.

`dsh` itself is a peer of the environment, not a bundled dependency: the plugin
declares no `peerDependencies` on dsh packages, because it resolves them through the
harness's own module table at runtime and degrades when they are absent.
