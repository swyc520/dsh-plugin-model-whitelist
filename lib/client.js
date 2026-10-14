/**
 * Model whitelist — browser half.
 *
 * Two halves of one feature:
 *
 *   1. **A settings panel** (Settings → Models → footer) listing every provider
 *      and model with a checkbox.
 *   2. **An actual filter on the model selector**, so unticked models disappear
 *      from the composer's model menu.
 *
 * Nothing is hidden by default: an empty whitelist leaves behaviour identical to
 * stock.
 *
 * ## Why the filter is a store projection, not a seat
 *
 * The harness publishes a `replaceRisk` for every slot. The model selector lives
 * in `conversation.input.model`, rated `shadows-shipped-ui`: registering there
 * *replaces* the official control, and with it the menu, the effort submenu, the
 * keyboard handling and the failure rows. A visibility preference is not worth
 * that trade, and an early attempt along those lines failed activation.
 *
 * The official selector instead reads the shared catalog through a public field:
 *
 *   ctx.modelDirectories.catalog.store.getSnapshot()
 *     -> { value: { groups: [{ id, name, models: [...] }], default, failures },
 *          status, error }
 *
 * `createSnapshotStore` returns a plain object whose `getSnapshot` is an ordinary
 * method (`{ getSnapshot, subscribe, update, set }`), so this plugin wraps that
 * one method and returns a projected snapshot. The official component then
 * renders its own UI over the filtered list — untouched markup, untouched
 * theming, untouched behaviour — and the real store is never written to.
 *
 * The projection is idempotent and total: it copies only the `groups` array, and
 * only when something is actually hidden. Every failure path returns the
 * original snapshot, so a bug here degrades to "no filtering", never to a broken
 * selector.
 *
 * @module @swyc520/dsh-plugin-model-whitelist/client
 */

window.__ModuleLoader__.load({
  id: '@swyc520/dsh-plugin-model-whitelist',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    /** localStorage key, versioned so a future shape change can migrate cleanly. */
    const STORAGE_KEY = 'dsh-model-whitelist/v1'

    /**
     * Stored shape: `{ hidden: { "<providerId>/<modelId>": true } }`.
     *
     * The *hidden* set is persisted rather than the *shown* set so a model the
     * user has never seen — a new release, a newly connected provider — stays
     * visible by default. Persisting the shown set would silently hide every new
     * model, which reads as a bug.
     */
    const EMPTY = Object.freeze({ hidden: Object.freeze({}) })

    /** The row id the official selector uses; kept identical so ids never drift. */
    function rowId(providerId, modelId) {
      return `${providerId}/${modelId}`
    }

    function readState() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw === null || raw === '') return EMPTY
        const parsed = JSON.parse(raw)
        const hidden = parsed?.hidden
        if (hidden === null || typeof hidden !== 'object') return EMPTY
        const clean = {}
        for (const [key, value] of Object.entries(hidden)) if (value === true) clean[key] = true
        return { hidden: clean }
      } catch {
        // A blocked or corrupt store must never take anything down.
        return EMPTY
      }
    }

    function writeState(next) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ hidden: next.hidden }))
        return true
      } catch {
        return false
      }
    }

    /** One external store shared by the panel and the catalog projection. */
    function createWhitelistStore() {
      let state = readState()
      const listeners = new Set()
      const emit = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            /* a broken listener must not break the others */
          }
        }
      }
      return {
        get: () => state,
        isEmpty: () => Object.keys(state.hidden).length === 0,
        isHidden: (providerId, modelId) => state.hidden[rowId(providerId, modelId)] === true,
        setHidden(providerId, modelId, hidden) {
          const key = rowId(providerId, modelId)
          const next = { ...state.hidden }
          if (hidden) next[key] = true
          else delete next[key]
          state = { hidden: next }
          const ok = writeState(state)
          emit()
          return ok
        },
        replace(hidden) {
          state = { hidden: { ...hidden } }
          const ok = writeState(state)
          emit()
          return ok
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        refresh() {
          const next = readState()
          if (JSON.stringify(next.hidden) !== JSON.stringify(state.hidden)) {
            state = next
            emit()
          }
        },
      }
    }

    /** React binding. `getSnapshot` returns the store's own stable object. */
    function useWhitelist(store) {
      return react.useSyncExternalStore(
        (onChange) => store.subscribe(onChange),
        () => store.get(),
        () => store.get(),
      )
    }

    /**
     * The harness's UI primitive library, or undefined.
     *
     * Resolved defensively: `require` throws for an id the browser module table
     * does not carry, and a throw during activation fails the entry — on a client
     * bundle that aborts the whole web boot. The panel falls back to plain
     * elements when this is undefined.
     *
     * @returns the primitives module, or undefined.
     */
    function resolvePrimitives() {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives')
      } catch {
        return undefined
      }
    }

    /**
     * Project a catalog snapshot through the hidden set.
     *
     * Only `value.groups[].models[]` is filtered; every other field (including
     * `value.default`, `value.failures`, `status` and `error`) rides along by
     * reference so the official selector keeps working against the objects it
     * expects.
     *
     * @param snapshot - the store's snapshot.
     * @param store - the whitelist store.
     * @returns the snapshot, or a filtered shallow copy.
     */
    function projectSnapshot(snapshot, store) {
      if (snapshot === null || typeof snapshot !== 'object') return snapshot
      if (store.isEmpty()) return snapshot
      const value = snapshot.value
      if (value === null || typeof value !== 'object') return snapshot
      const groups = value.groups
      if (!Array.isArray(groups)) return snapshot

      let changed = false
      const nextGroups = groups.map((group) => {
        const models = group?.models
        if (!Array.isArray(models)) return group
        const kept = models.filter((model) => store.isHidden(group.id, model?.id) !== true)
        if (kept.length === models.length) return group
        changed = true
        return { ...group, models: kept }
      })
      if (!changed) return snapshot
      return { ...snapshot, value: { ...value, groups: nextGroups } }
    }

    /**
     * Wrap the catalog store's `getSnapshot` so the official selector sees the
     * filtered catalog.
     *
     * The wrapper is installed once and is reversible; the store's other members
     * are left alone, and `subscribe` still reports the *real* store's changes so
     * the official component re-renders on every catalog update. Whitelist edits
     * are pushed to the same listeners, because the official component must
     * re-render when a model is hidden or restored.
     *
     * @param catalog - `ctx.modelDirectories.catalog`.
     * @param store - the whitelist store.
     * @param ctx - client context, used for effect-scoped disposal.
     */
    function installCatalogFilter(catalog, store, ctx) {
      const inner = catalog?.store
      if (inner === null || typeof inner !== 'object') return
      if (typeof inner.getSnapshot !== 'function') return
      if (inner.__modelWhitelistPatched === true) return

      const original = inner.getSnapshot
      inner.getSnapshot = function modelWhitelistGetSnapshot() {
        try {
          return projectSnapshot(original.call(this), store)
        } catch {
          // A projection bug must degrade to "unfiltered", never to a broken
          // selector.
          return original.call(this)
        }
      }
      inner.__modelWhitelistPatched = true
      // The settings panel needs the unfiltered catalog: it must list hidden
      // models too, or a hidden row could never be restored.
      inner.__modelWhitelistRaw = () => original.call(inner)

      ctx.effect(() => () => {
        try {
          if (inner.getSnapshot === modelWhitelistGetSnapshot) {
            inner.getSnapshot = original
            delete inner.__modelWhitelistPatched
            delete inner.__modelWhitelistRaw
          }
        } catch {
          /* the store is gone; nothing to restore */
        }
      }, 'model-whitelist: catalog projection')
    }

    const NS = 'model-whitelist'

    const zh = {
      'panel.title': '模型显示',
      'panel.description': '勾选要显示在模型选择器里的模型。未勾选的会从选择器菜单中消失，随时可以在这里恢复。',
      'panel.loading': '正在读取模型清单……',
      'panel.empty': '还没有读到模型清单。打开一次模型选择器即可加载。',
      'panel.failed': '读取模型清单失败：{message}',
      'panel.showing': '显示 {shown}/{total}',
      'panel.showAll': '全部显示',
      'panel.hideAll': '全部隐藏',
      'panel.groupHidden': '已隐藏 {n}',
      'panel.saveFailed': '浏览器拒绝了本地存储，本次更改仅在当前页面有效。',
      'panel.note': '白名单保存在浏览器本地存储里，跟随当前地址；不会写入 DSH 配置，也不改变模型本身，只是让它们不出现在选择器菜单中。',
      'panel.reload': '重新读取',
    }

    const en = {
      'panel.title': 'Model visibility',
      'panel.description': 'Tick the models that should appear in the model selector. Unticked ones disappear from the selector menu and can be restored here at any time.',
      'panel.loading': 'Reading the model catalog…',
      'panel.empty': 'No catalog yet. Open the model selector once to load it.',
      'panel.failed': 'Could not read the model catalog: {message}',
      'panel.showing': 'Showing {shown}/{total}',
      'panel.showAll': 'Show all',
      'panel.hideAll': 'Hide all',
      'panel.groupHidden': '{n} hidden',
      'panel.saveFailed': 'The browser refused local storage; this change lasts only for the current page.',
      'panel.note': 'The whitelist lives in this browser\'s local storage, scoped to this address. It is not written to DSH configuration and does not change the models themselves — it only keeps them out of the selector menu.',
      'panel.reload': 'Reload',
    }

    /**
     * The settings panel.
     *
     * Renders one card per provider with a checkbox per model. Every count comes
     * from the live catalog, so the panel never disagrees with the selector.
     */
    function createPanel(deps) {
      const { store, primitives, t, useCatalog } = deps
      const Button = primitives?.Button

      return function ModelWhitelistPanel() {
        const state = useWhitelist(store)
        const catalog = useCatalog()
        const [saveFailed, setSaveFailed] = react.useState(false)

        const groups = Array.isArray(catalog.groups) ? catalog.groups : []
        const total = groups.reduce((n, g) => n + (Array.isArray(g?.models) ? g.models.length : 0), 0)
        const shown = groups.reduce(
          (n, g) =>
            n + (Array.isArray(g?.models) ? g.models.filter((m) => store.isHidden(g.id, m?.id) !== true).length : 0),
          0,
        )

        const children = []

        children.push(
          react.createElement(
            'div',
            {
              key: 'head',
              style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
            },
            react.createElement('strong', { style: { fontSize: 14 } }, t('panel.title')),
            react.createElement('span', { style: { fontSize: 12, opacity: 0.7 } },
              total > 0 ? t('panel.showing').replace('{shown}', String(shown)).replace('{total}', String(total)) : ''),
          ),
          react.createElement('div', { key: 'desc', style: { fontSize: 12, opacity: 0.75 } }, t('panel.description')),
        )

        if (catalog.status === 'loading' && total === 0) {
          children.push(react.createElement('div', { key: 'loading', style: { fontSize: 12, opacity: 0.7 } }, t('panel.loading')))
        } else if (catalog.error !== null && total === 0) {
          children.push(
            react.createElement('div', { key: 'failed', style: { fontSize: 12, opacity: 0.8 } },
              t('panel.failed').replace('{message}', String(catalog.error))),
          )
        } else if (total === 0) {
          children.push(react.createElement('div', { key: 'empty', style: { fontSize: 12, opacity: 0.7 } }, t('panel.empty')))
        }

        if (total > 0) {
          const showAll = Button !== undefined
            ? react.createElement(Button, { key: 'showAll', onClick: () => setSaveFailed(store.replace({}) === false) }, t('panel.showAll'))
            : react.createElement('button', { type: 'button', key: 'showAll', onClick: () => setSaveFailed(store.replace({}) === false) }, t('panel.showAll'))
          const hideAll = Button !== undefined
            ? react.createElement(
                Button,
                {
                  key: 'hideAll',
                  onClick: () => {
                    const next = {}
                    for (const g of groups) for (const m of g?.models ?? []) next[rowId(g.id, m?.id)] = true
                    setSaveFailed(store.replace(next) === false)
                  },
                },
                t('panel.hideAll'),
              )
            : react.createElement(
                'button',
                {
                  type: 'button',
                  key: 'hideAll',
                  onClick: () => {
                    const next = {}
                    for (const g of groups) for (const m of g?.models ?? []) next[rowId(g.id, m?.id)] = true
                    setSaveFailed(store.replace(next) === false)
                  },
                },
                t('panel.hideAll'),
              )
          const reload = react.createElement(
            'button',
            { type: 'button', key: 'reload', onClick: () => catalog.reload() },
            t('panel.reload'),
          )
          children.push(
            react.createElement('div', { key: 'actions', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              showAll, hideAll, reload),
          )

          for (const group of groups) {
            const models = Array.isArray(group?.models) ? group.models : []
            if (models.length === 0) continue
            const hiddenInGroup = models.filter((m) => store.isHidden(group.id, m?.id) === true).length
            children.push(
              react.createElement(
                'div',
                {
                  key: 'g:' + group.id,
                  style: {
                    border: '1px solid var(--dsw-border, rgba(128,128,128,0.25))',
                    borderRadius: 8,
                    padding: '8px 10px',
                  },
                },
                react.createElement(
                  'div',
                  { style: { display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 } },
                  react.createElement('strong', { style: { fontSize: 13 } }, group.name ?? group.id),
                  react.createElement('span', { style: { fontSize: 11, opacity: 0.65 } },
                    hiddenInGroup > 0 ? t('panel.groupHidden').replace('{n}', String(hiddenInGroup)) : ''),
                ),
                ...models.map((model) => {
                  const id = rowId(group.id, model?.id)
                  const hidden = store.isHidden(group.id, model?.id) === true
                  return react.createElement(
                    'label',
                    {
                      key: id,
                      style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: 'pointer' },
                    },
                    react.createElement('input', {
                      type: 'checkbox',
                      checked: !hidden,
                      onChange: () => setSaveFailed(store.setHidden(group.id, model?.id, !hidden) === false),
                    }),
                    react.createElement('span', { style: { fontSize: 13 } }, model?.name ?? model?.id ?? ''),
                  )
                }),
              ),
            )
          }
        }

        if (saveFailed) {
          children.push(react.createElement('div', { key: 'err', style: { fontSize: 12, opacity: 0.9 } }, t('panel.saveFailed')))
        }
        children.push(react.createElement('div', { key: 'note', style: { fontSize: 11, opacity: 0.7 } }, t('panel.note')))

        return react.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, ...children)
      }
    }

    /**
     * Services this plugin requires before `apply` may run.
     *
     * Cordis reads this array off the plugin module and holds activation until
     * every name resolves. Omitting it lets `apply` run before `slots` exists,
     * the entry never activates, and the harness aborts the web boot with
     * "1 entry did not activate".
     */
    const inject = ['locale', 'slots']

    /**
     * Client plugin body.
     *
     * Installs the catalog projection, then registers the settings panel. The
     * projection is best-effort by design: if the catalog service is absent or
     * shaped differently, the plugin still registers its panel and simply does
     * not filter.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      const locale = ctx.get('locale')

      let T = (key, params) => {
        let value = zh[key] ?? key
        for (const [k, v] of Object.entries(params ?? {})) value = value.replace(`{${k}}`, String(v))
        return value
      }

      if (locale?.register !== undefined) {
        ctx.effect(() => locale.register(NS, { zh, en }), 'model-whitelist: dictionaries')
        const bound = locale.bind?.(NS)
        if (bound !== undefined) {
          T = (key, params) => {
            const paramsObj = params ?? {}
            try {
              return bound(key, paramsObj)
            } catch {
              let value = zh[key] ?? key
              for (const [k, v] of Object.entries(paramsObj)) value = value.replace(`{${k}}`, String(v))
              return value
            }
          }
        }
      }

      const store = createWhitelistStore()

      // Cross-tab edits propagate through the `storage` event.
      ctx.effect(() => {
        const onStorage = (event) => {
          if (event.key === null || event.key === STORAGE_KEY) store.refresh()
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
      }, 'model-whitelist: cross-tab sync')

      /**
       * Access the model catalog through the official service.
       *
       * `ctx.get` is called lazily on every read because the service may be
       * published after this plugin activates.
       *
       * @returns the catalog, or undefined.
       */
      function catalogOf() {
        try {
          return ctx.get('modelDirectories')?.catalog
        } catch {
          return undefined
        }
      }

      // Install the projection as soon as the service exists. Polling is used
      // because a client plugin has no hook for "service appeared"; the interval
      // is cleared the moment the projection is in place.
      ctx.effect(() => {
        let done = false
        const tryInstall = () => {
          if (done) return
          const catalog = catalogOf()
          if (catalog === undefined) return
          installCatalogFilter(catalog, store, ctx)
          done = true
        }
        tryInstall()
        const timer = window.setInterval(() => {
          tryInstall()
          if (done) window.clearInterval(timer)
        }, 500)
        return () => window.clearInterval(timer)
      }, 'model-whitelist: install catalog projection')

      /**
       * Read the catalog for the panel, re-rendering on catalog and whitelist
       * changes.
       *
       * @returns `{ groups, status, error, reload }`.
       */
      function useCatalog() {
        const [snapshot, setSnapshot] = react.useState(() => {
          try {
            return catalogOf()?.store?.getSnapshot?.() ?? null
          } catch {
            return null
          }
        })

        react.useEffect(() => {
          let unsubscribe = null
          const read = () => {
            try {
              setSnapshot(catalogOf()?.store?.getSnapshot?.() ?? null)
            } catch {
              setSnapshot(null)
            }
          }
          read()
          try {
            const catalog = catalogOf()
            const handle = catalog?.store
            if (handle !== null && handle !== undefined && typeof handle.subscribe === 'function') {
              unsubscribe = handle.subscribe(read)
            }
            catalog?.load?.()?.catch?.(() => {})
          } catch {
            /* the service is absent in this composition */
          }
          // Whitelist edits must refresh the counts even without a catalog change.
          const offStore = store.subscribe(read)
          return () => {
            try {
              unsubscribe?.()
            } catch {
              /* already disposed */
            }
            offStore()
          }
        }, [])

        // The panel always reports the *unfiltered* catalog — the checkbox list
        // must show every model, including the hidden ones, or hidden rows could
        // never be restored.
        const raw = react.useMemo(() => {
          try {
            return catalogOf()?.store?.__modelWhitelistRaw?.() ?? snapshot
          } catch {
            return snapshot
          }
        }, [snapshot])

        const value = raw?.value ?? null
        return {
          groups: Array.isArray(value?.groups) ? value.groups : [],
          status: raw?.status ?? 'idle',
          error: raw?.error ?? null,
          reload: () => {
            try {
              catalogOf()?.load?.()?.catch?.(() => {})
            } catch {
              /* nothing to reload */
            }
          },
        }
      }

      const primitives = resolvePrimitives()
      const Panel = createPanel({ store, primitives, t: T, useCatalog })

      ctx.inject(['slots'], (scope) => {
        try {
          scope.slots.inject('settings.models.footer', () =>
            scope.slots.register(
              {
                name: 'settings.models.footer',
                id: 'model-whitelist',
                order: 100,
                label: () => T('panel.title'),
              },
              Panel,
            ),
          )
        } catch {
          /* the Models settings section is absent in this composition */
        }
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.rowId = rowId
    exports.projectSnapshot = projectSnapshot
    return module.exports
  },
})
