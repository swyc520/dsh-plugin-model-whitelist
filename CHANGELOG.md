# Changelog

Notable changes to this plugin. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-14

### Added

- **Collapsible provider groups** in the Model visibility panel. Click a card's title row
  to fold or unfold that provider; the chevron rotates and the header shows the group's
  model count, or the number hidden when any are.
- **Expand all** and **Collapse all** buttons for the bulk case.
- The folded state is persisted and survives a reload.

### Notes

- Collapsing is a reading aid stored in its own `collapsed` map. It hides no models, and
  the model selector is unaffected — folding a group never changes what the selector
  offers. Three assertions in `scripts/verify-client.mjs` cover this distinction.
- The storage schema gains a second map. `readState` tolerates either map being absent or
  malformed, so existing `v1` records keep working with no migration.

## [0.1.0] - 2026-10-14

### Added

- Initial release. A **Model visibility** panel in **Settings → Models** listing every
  provider and model with a checkbox, plus **Show all** / **Hide all** / **Reload**.
- Unticked models are removed from the composer's model selector menu.

### Notes

- The filter wraps `ctx.modelDirectories.catalog.store.getSnapshot()` and returns a
  projected snapshot, so the official selector keeps rendering its own UI over a filtered
  list. The official control is never shadowed.
- An empty whitelist returns the original snapshot object: stock behaviour is unchanged by
  default.
- Every fallible read degrades instead of throwing, so the worst case is "nothing is
  hidden" rather than a failed web boot.

[0.2.0]: https://github.com/swyc520/dsh-plugin-model-whitelist/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/swyc520/dsh-plugin-model-whitelist/releases/tag/v0.1.0
