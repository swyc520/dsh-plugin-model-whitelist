/**
 * Model whitelist — plugin entry (Host half).
 *
 * Pure UI plugin: the browser half ships via `exports["./client"]`, discovered
 * through the `dsh.client` declaration in package.json. The host half exists
 * only so the plugin appears in the host cordis.yml / Loader tree — the
 * whitelist itself is client-side state, so there is no host-side behaviour.
 *
 * @module @swyc520/dsh-plugin-model-whitelist
 */

/** Host plugin body — no host-side behaviour for this surface plugin. */
export function apply() {}
