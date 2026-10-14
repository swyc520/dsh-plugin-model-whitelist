/**
 * Standalone verification for the browser half.
 *
 * Loads `lib/client.js` through a stubbed module table and a minimal
 * hook-aware renderer, then asserts the plugin's contract and — most
 * importantly — that the catalog projection really removes hidden models while
 * leaving everything else intact.
 *
 * No dependencies: the harness is not required to run this.
 *
 *   node scripts/verify-client.mjs
 *
 * Exits non-zero on the first failed assertion group.
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '..', 'lib', 'client.js')
const PKG = path.join(here, '..', 'package.json')

let passed = 0
let failed = 0

/**
 * Run one assertion.
 * @param {string} name - what is being asserted.
 * @param {() => void} body - throws on failure.
 */
function check(name, body) {
  try {
    body()
    console.log(`PASS  ${name}`)
    passed += 1
  } catch (error) {
    console.log(`FAIL  ${name} -> ${error.message}`)
    failed += 1
  }
}

/**
 * Deep-equality assertion that reports the actual value.
 * @param {unknown} actual - observed.
 * @param {unknown} expected - required.
 * @param {string} what - subject of the comparison.
 */
function eq(actual, expected, what) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}\n      got:  ${a}\n      want: ${b}`)
}

/** The React surface the plugin actually touches. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useRef: (value) => ({ current: value }),
  Fragment: 'Fragment',
}

const localeStub = {
  register: () => () => {},
  bind: () => (key) => key,
}

/**
 * Build the sandbox the bundle executes in.
 * @param {{ storage?: object }} [opts] - overrides.
 * @returns {object} the sandbox, with `__loader` holding the captured entry.
 */
function makeSandbox(opts = {}) {
  const storage = opts.storage ?? {
    _data: {},
    getItem(key) {
      return this._data[key] ?? null
    },
    setItem(key, value) {
      this._data[key] = String(value)
    },
    removeItem(key) {
      delete this._data[key]
    },
  }
  const timers = []
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: {
        load: (entry) => {
          sandbox.__loader = entry
        },
      },
      localStorage: storage,
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearInterval: () => {},
    },
    __timers: timers,
    require: (id) => {
      if (id === 'react') return reactStub
      throw new Error(`module not in table: ${id}`)
    },
    module: { exports: {} },
    exports: {},
    Symbol,
    Object,
    Array,
    JSON,
    String,
    Number,
    Boolean,
    Error,
    Math,
    Date,
    RegExp,
    Set,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
  }
  sandbox.globalThis = sandbox
  return sandbox
}

/**
 * Execute the bundle in a fresh sandbox and materialize its factory.
 * @param {{ storage?: object }} [opts] - overrides.
 * @returns {{ module: object, sandbox: object }} the plugin exports and its sandbox.
 */
function loadPlugin(opts = {}) {
  const sandbox = makeSandbox(opts)
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' })
  const loader = sandbox.__loader
  if (loader === undefined) throw new Error('bundle did not call window.__ModuleLoader__.load')
  return { module: loader.factory(sandbox.require), sandbox }
}

/** A catalog snapshot shaped like the harness produces. */
function snapshot() {
  return {
    value: {
      default: { provider: 'alpha', model: 'm1' },
      groups: [
        { id: 'alpha', name: 'Alpha', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] },
        { id: 'beta', name: 'Beta', models: [{ id: 'm3', name: 'M3' }] },
      ],
      failures: [],
    },
    status: 'ready',
    error: null,
  }
}

/**
 * A catalog store double exposing the same members as `createSnapshotStore`.
 * @param {object} initial - the starting snapshot.
 * @returns {object} `{ store, load, push }`.
 */
function makeCatalog(initial) {
  let current = initial
  const subscribers = new Set()
  return {
    store: {
      getSnapshot: () => current,
      subscribe: (fn) => {
        subscribers.add(fn)
        return () => subscribers.delete(fn)
      },
      update: (mutator) => mutator(current),
      set: (next) => {
        current = next
        for (const fn of subscribers) fn()
      },
    },
    load: () => Promise.resolve(),
    push: (next) => {
      current = next
      for (const fn of subscribers) fn()
    },
  }
}

/**
 * A client context double.
 * @param {object} opts - `catalog`, `noCatalog`, `noLocale`, `noSeat`.
 * @returns {object} the context, with `seat` attached after `apply`.
 */
function makeContext(opts = {}) {
  const services = {
    locale: opts.noLocale === true ? undefined : localeStub,
    modelDirectories: opts.noCatalog === true ? undefined : { catalog: opts.catalog },
  }
  const ctx = {
    seat: null,
    get: (name) => services[name],
    effect: (fn) => {
      try {
        return fn()
      } catch {
        return () => {}
      }
    },
    inject: (_deps, fn) =>
      fn({
        slots: {
          inject: (_name, cb) => {
            if (opts.noSeat === true) throw new Error('slot not declared')
            return cb()
          },
          register: (options, component) => {
            ctx.seat = { options, component }
            return () => {}
          },
        },
      }),
  }
  return ctx
}

/** Visible model ids per group, as the selector would see them. */
function visible(catalog) {
  return catalog.store.getSnapshot().value.groups.map((group) => group.models.map((model) => model.id))
}

/** Collect every string in a rendered element tree. */
function textsOf(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (Array.isArray(node.children)) for (const child of node.children) textsOf(child, out)
  return out
}

console.log('=== package manifest ===')
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
check('name is scoped and versioned', () => {
  if (!pkg.name.startsWith('@')) throw new Error(`unscoped name: ${pkg.name}`)
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+/.test(pkg.version)) throw new Error('bad version')
})
check('declares dsh.bundle.patch', () => eq(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'bundle.patch'))
check('declares dsh.client for web', () => eq(pkg.dsh?.client?.platform, 'web', 'client.platform'))
check('exports ./client', () => eq(pkg.exports?.['./client'], './lib/client.js', 'exports["./client"]'))
check('ships lib, patch, README and LICENSE', () => {
  for (const required of ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    if (!pkg.files?.includes(required)) throw new Error(`missing from files: ${required}`)
  }
})
check('LICENSE and notice files exist', () => {
  for (const required of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'cordis.patch.yml']) {
    if (!fs.existsSync(path.join(here, '..', required))) throw new Error(`missing file: ${required}`)
  }
})

console.log('\n=== bundle contract ===')
const { module: plugin } = loadPlugin()
const catalog = makeCatalog(snapshot())
const ctx = makeContext({ catalog })
plugin.apply(ctx)

check('exports apply', () => {
  if (typeof plugin.apply !== 'function') throw new Error('apply is not a function')
})
check('exports inject as a string array', () => {
  if (!Array.isArray(plugin.inject)) throw new Error('inject is not an array')
  if (plugin.inject.some((name) => typeof name !== 'string')) throw new Error('non-string entry')
})
check('inject declares locale and slots', () => eq(plugin.inject, ['locale', 'slots'], 'inject'))
check('exports rowId', () => {
  if (typeof plugin.rowId !== 'function') throw new Error('rowId is not a function')
  eq(plugin.rowId('p', 'm'), 'p/m', 'rowId format')
})

console.log('\n=== seat registration ===')
check('registers into settings.models.footer', () => eq(ctx.seat?.options?.name, 'settings.models.footer', 'seat'))
check('takes no priority (list slot, additive)', () => eq(ctx.seat?.options?.priority, undefined, 'priority'))
check('component is a function', () => {
  if (typeof ctx.seat?.component !== 'function') throw new Error('component is not a function')
})
check('renders without throwing', () => {
  const element = ctx.seat.component({})
  if (element === null || element === undefined) throw new Error('rendered nothing')
})

console.log('\n=== projection (the feature) ===')
const emptyStore = { isEmpty: () => true, isHidden: () => false }
const hidingM2 = { isEmpty: () => false, isHidden: (g, m) => g === 'alpha' && m === 'm2' }

check('empty whitelist returns the SAME object', () => {
  const snap = snapshot()
  if (plugin.projectSnapshot(snap, emptyStore) !== snap) throw new Error('not identity — stock behaviour would change')
})
check('a hidden model leaves the selector list', () => {
  const out = plugin.projectSnapshot(snapshot(), hidingM2)
  eq(out.value.groups.map((g) => g.models.map((m) => m.id)), [['m1'], ['m3']], 'visible models')
})
check('untouched groups and other fields keep their identity', () => {
  const snap = snapshot()
  const out = plugin.projectSnapshot(snap, hidingM2)
  if (out.value.default !== snap.value.default) throw new Error('value.default not preserved by reference')
  if (out.value.failures !== snap.value.failures) throw new Error('value.failures not preserved by reference')
  if (out.status !== snap.status) throw new Error('status not preserved')
  if (out.value.groups[1] !== snap.value.groups[1]) throw new Error('untouched group not preserved by reference')
})
check('null and malformed snapshots pass through untouched', () => {
  const hidingAll = { isEmpty: () => false, isHidden: () => true }
  eq(plugin.projectSnapshot(null, hidingAll), null, 'null')
  eq(plugin.projectSnapshot(undefined, hidingAll), undefined, 'undefined')
  const bare = { status: 'idle' }
  if (plugin.projectSnapshot(bare, hidingAll) !== bare) throw new Error('bare object changed')
  const noGroups = { value: { groups: 'nope' } }
  if (plugin.projectSnapshot(noGroups, hidingAll) !== noGroups) throw new Error('non-array groups changed')
})
check('projection is idempotent', () => {
  const once = plugin.projectSnapshot(snapshot(), hidingM2)
  const twice = plugin.projectSnapshot(once, hidingM2)
  eq(twice.value.groups.map((g) => g.models.map((m) => m.id)), [['m1'], ['m3']], 'second pass')
})

console.log('\n=== live wiring ===')
check('apply installs the projection on the catalog store', () => {
  const live = makeCatalog(snapshot())
  const liveCtx = makeContext({ catalog: live })
  loadPlugin().module.apply(liveCtx)
  eq(live.store.__modelWhitelistPatched, true, 'patched flag')
})
check('projection survives through getSnapshot', () => {
  const storage = {
    _data: { 'dsh-model-whitelist/v1': JSON.stringify({ hidden: { 'alpha/m2': true } }) },
    getItem(key) {
      return this._data[key] ?? null
    },
    setItem(key, value) {
      this._data[key] = String(value)
    },
    removeItem(key) {
      delete this._data[key]
    },
  }
  const live = makeCatalog(snapshot())
  const { module: fresh, sandbox } = loadPlugin({ storage })
  fresh.apply(makeContext({ catalog: live }))
  for (const tick of sandbox.__timers) tick()
  eq(visible(live), [['m1'], ['m3']], 'selector view')
})
check('the unfiltered catalog stays reachable for the panel', () => {
  const storage = {
    _data: { 'dsh-model-whitelist/v1': JSON.stringify({ hidden: { 'alpha/m2': true } }) },
    getItem(key) {
      return this._data[key] ?? null
    },
    setItem(key, value) {
      this._data[key] = String(value)
    },
    removeItem(key) {
      delete this._data[key]
    },
  }
  const live = makeCatalog(snapshot())
  const { module: fresh, sandbox } = loadPlugin({ storage })
  const liveCtx = makeContext({ catalog: live })
  fresh.apply(liveCtx)
  for (const tick of sandbox.__timers) tick()
  const raw = live.store.__modelWhitelistRaw()
  eq(raw.value.groups.map((g) => g.models.map((m) => m.id)), [['m1', 'm2'], ['m3']], 'raw catalog')
  const labels = textsOf(liveCtx.seat.component({}))
  if (!labels.includes('M2')) throw new Error('hidden model is missing from the panel, so it could never be restored')
})

console.log('\n=== collapse (panel reading aid) ===')

/** Find the first element whose props carry the given `aria-expanded`. */
function findToggle(node) {
  if (node === null || node === undefined) return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findToggle(child)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (typeof node !== 'object') return undefined
  if (node.props?.onClick !== undefined && node.props['aria-expanded'] !== undefined) return node
  if (Array.isArray(node.children)) return findToggle(node.children)
  return undefined
}

/** Count the model checkboxes currently rendered. */
function countCheckboxes(node) {
  if (node === null || node === undefined) return 0
  if (Array.isArray(node)) return node.reduce((n, child) => n + countCheckboxes(child), 0)
  if (typeof node !== 'object') return 0
  let total = node.type === 'input' && node.props?.type === 'checkbox' ? 1 : 0
  if (Array.isArray(node.children)) total += countCheckboxes(node.children)
  return total
}

check('collapsed state persists across a reload', () => {
  const storage = {
    _data: {
      'dsh-model-whitelist/v1': JSON.stringify({ hidden: {}, collapsed: { alpha: true } }),
    },
    getItem(key) {
      return this._data[key] ?? null
    },
    setItem(key, value) {
      this._data[key] = String(value)
    },
    removeItem(key) {
      delete this._data[key]
    },
  }
  const live = makeCatalog(snapshot())
  const { module: fresh, sandbox } = loadPlugin({ storage })
  const liveCtx = makeContext({ catalog: live })
  fresh.apply(liveCtx)
  for (const tick of sandbox.__timers) tick()
  const tree = liveCtx.seat.component({})
  const toggles = []
  const collect = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) return node.forEach(collect)
    if (typeof node !== 'object') return
    if (node.props?.['aria-expanded'] !== undefined) toggles.push(node.props['aria-expanded'])
    if (Array.isArray(node.children)) node.children.forEach(collect)
  }
  collect(tree)
  // Two provider cards: alpha collapsed (aria-expanded false), beta expanded.
  eq(toggles, [false, true], 'aria-expanded per card')
})
check('a folded card renders no checkboxes for its models', () => {
  const storage = {
    _data: {
      'dsh-model-whitelist/v1': JSON.stringify({ hidden: {}, collapsed: { alpha: true } }),
    },
    getItem(key) {
      return this._data[key] ?? null
    },
    setItem(key, value) {
      this._data[key] = String(value)
    },
    removeItem(key) {
      delete this._data[key]
    },
  }
  const live = makeCatalog(snapshot())
  const { module: fresh, sandbox } = loadPlugin({ storage })
  const openCtx = makeContext({ catalog: live })
  fresh.apply(openCtx)
  for (const tick of sandbox.__timers) tick()
  // alpha holds m1+m2, beta holds m3. Folded alpha leaves only m3 visible.
  eq(countCheckboxes(openCtx.seat.component({})), 1, 'visible checkboxes')
})
check('toggling a card folds it without hiding its models', () => {
  const storage = {
    _data: { 'dsh-model-whitelist/v1': JSON.stringify({ hidden: {}, collapsed: {} }) },
    getItem(key) {
      return this._data[key] ?? null
    },
    setItem(key, value) {
      this._data[key] = String(value)
    },
    removeItem(key) {
      delete this._data[key]
    },
  }
  const live = makeCatalog(snapshot())
  const { module: fresh, sandbox } = loadPlugin({ storage })
  const liveCtx = makeContext({ catalog: live })
  fresh.apply(liveCtx)
  for (const tick of sandbox.__timers) tick()
  eq(countCheckboxes(liveCtx.seat.component({})), 3, 'all checkboxes before folding')
  const toggle = findToggle(liveCtx.seat.component({}))
  if (toggle === undefined) throw new Error('no collapsible header found')
  toggle.props.onClick()
  eq(countCheckboxes(liveCtx.seat.component({})), 1, 'checkboxes after folding alpha')
  // Folding is a display concern: nothing may enter the hidden set.
  const stored = JSON.parse(storage._data['dsh-model-whitelist/v1'])
  eq(stored.hidden, {}, 'hidden set untouched by folding')
  eq(stored.collapsed, { alpha: true }, 'collapsed set recorded')
  // The selector still sees every model.
  eq(visible(live), [['m1', 'm2'], ['m3']], 'selector unaffected by folding')
})

console.log('\n=== degradation ===')
check('no catalog service: apply and render still work', () => {
  const solo = loadPlugin().module
  const soloCtx = makeContext({ noCatalog: true })
  solo.apply(soloCtx)
  if (soloCtx.seat.component({}) === null) throw new Error('rendered nothing')
})
check('no locale service: apply and render still work', () => {
  const solo = loadPlugin().module
  const soloCtx = makeContext({ noCatalog: true, noLocale: true })
  solo.apply(soloCtx)
  if (soloCtx.seat.component({}) === null) throw new Error('rendered nothing')
})
check('missing slot: apply does not throw', () => {
  const solo = loadPlugin().module
  solo.apply(makeContext({ noCatalog: true, noSeat: true }))
})
check('refused local storage: apply and render still work', () => {
  const blocked = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    },
  }
  const solo = loadPlugin({ storage: blocked }).module
  const soloCtx = makeContext({ catalog: makeCatalog(snapshot()) })
  solo.apply(soloCtx)
  if (soloCtx.seat.component({}) === null) throw new Error('rendered nothing')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
