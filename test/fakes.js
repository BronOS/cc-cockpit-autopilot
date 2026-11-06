'use strict'
// Fakes shared by the suites: a cc-cockpit ctx written from `ccc guide api` (0.9.7) with
// `ctx.services.useAll('inbox-feed')` over providers a test adds and removes, an optional `jev`
// provider behind `ctx.services.use` (its `grid`), ctx.appStorage for the Jev cache,
// `ctx.sessions.open` that records prompts (or refuses) and adds the tab to `ctx.sessions.list()` /
// `onChange` (status, sessionId, typed: moved on by the test), a per-project store, and recorded posts,
// headers, notifications and logs. A fake clock drives both `now` and the timers, so no test waits on a real timer. Every name and id here is example data
// (Ann Example, SUP-123, example.com). (bronos.inbox's fakes.js, with sessions and jev.)

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const NOW = Date.parse('2026-11-03T12:42:00Z')
const RULES_FILE = 'autopilot-rules.json'
const MIN = 60000
const HOUR = 60 * MIN

/**
 * A v2 FeedItem as a provider answers it (bronos.inbox design-v2 "The item"). `o.from` / `o.where` are
 * the person's name and the place's name; `extra` is merged last (an unknown field, a hostile value).
 */
function item(id, o = {}) {
  return {
    id,
    rev: o.rev || `${id}-r1`,
    title: o.title || `Item ${id}`,
    time: o.time === undefined ? NOW - HOUR : o.time,
    read: o.read === undefined ? false : o.read,
    from: { name: o.from || 'Ann Example' },
    place: { kind: 'channel', name: o.where || 'Inbox' },
    actions: [{ id: 'open', label: 'Open' }],
    ...(o.mentionsMe !== undefined ? { mentionsMe: o.mentionsMe } : {}),
    ...(o.preview !== undefined ? { preview: o.preview } : {}),
    ...(o.labels !== undefined ? { labels: o.labels } : {}),
    ...(o.extra || {}),
  }
}
/** The same item with no `from` and no `place` (a source that has neither). */
const bare = (id, o = {}) => {
  const { from, place, ...rest } = item(id, o)
  return rest
}

/**
 * A fake `inbox-feed` v2 provider: `snapshot()` answers `{ items: feed.items, state }`. `feed.hold()`
 * makes the next snapshot wait until the returned `release()` is called, answering what `feed.items`
 * held when it was asked (a snapshot that resolves late, after newer events). `feed.throwOn` =
 * 'snapshot' | 'describe' | 'act' makes that call reject. `act(id, action)` (0.3.0's act rules) answers
 * `feed.actResult` (default `{ ok: true }`; a function of `(id, action)` for one answer per call) and
 * calls `feed.onAct(id, action)` first when set (a test looks at the claim while the act runs). Calls
 * are recorded.
 */
function fakeFeed(describe, items = []) {
  const feed = {
    items,
    state: 'ok',
    calls: [],
    throwOn: null,
    actResult: { ok: true },
    onAct: null,
    held: null,
    hold() {
      let release
      feed.held = new Promise((r) => (release = r))
      return () => release()
    },
    impl: {
      async describe() {
        feed.calls.push(['describe'])
        if (feed.throwOn === 'describe') throw new Error('describe broke')
        return describe
      },
      async features() {
        return []
      },
      async act(id, action) {
        feed.calls.push(['act', id, action])
        if (feed.onAct) await feed.onAct(id, action)
        if (feed.throwOn === 'act') throw new Error('act broke')
        return typeof feed.actResult === 'function' ? feed.actResult(id, action) : feed.actResult
      },
      async snapshot() {
        feed.calls.push(['snapshot'])
        if (feed.throwOn === 'snapshot') throw new Error('feed broke')
        const answer = { items: structuredClone(feed.items), state: feed.state, asOf: NOW }
        if (feed.held) {
          const gate = feed.held
          feed.held = null
          await gate
        }
        return answer
      },
    },
  }
  return feed
}

const CHAT = { label: 'Chat', badge: 'CHAT', color: 'green', kind: 'chat' }
const MAIL = { label: 'Mail', badge: 'MAIL', color: 'red', kind: 'mail' }
const JIRA = { label: 'Jira', badge: 'JIRA', color: 'blue', kind: 'issues' }

/**
 * A fake `jev` provider. `grid(items, questions, options)` answers every item with `answer`: a noul
 * score, an Error (the call rejects), or a function of `(text, instructions)` giving either (per item;
 * `null` from it leaves that item without a score). `jev.hold()` makes the next grid wait until the
 * returned `release()` (an answer still pending). Calls recorded as `{ items, questions, options }`.
 */
function fakeJev(answer = 0.9) {
  const jev = {
    answer,
    calls: [],
    held: null,
    hold() {
      let release
      jev.held = new Promise((r) => (release = r))
      return () => release()
    },
    impl: {
      async grid(items, questions, options) {
        jev.calls.push({ items, questions, options })
        if (jev.held) {
          const gate = jev.held
          jev.held = null
          await gate
        }
        const q = Object.values(questions)[0]
        const results = {}
        for (const it of items) {
          const p = typeof jev.answer === 'function' ? jev.answer(it.text, q.instructions) : jev.answer
          if (p instanceof Error) throw p
          results[it.id] = p === null ? { error: 'no answer' } : { answers: { q: { type: 'noul', noul: p } } }
        }
        return { results, tokens: 10, cost: 0.0002, ms: 5, model: 'test' }
      },
    },
  }
  return jev
}

/** A handle like the app's: every property but `on` is an async method, data copied both ways. */
function handleOf(getImpl, label, service) {
  return new Proxy(
    { on: () => () => {} },
    {
      get(target, prop) {
        if (prop in target) return target[prop]
        if (prop === 'then') return undefined
        return async (...args) => {
          const impl = getImpl()
          if (!impl) throw new Error(`no enabled plugin in this project provides service "${service}"`)
          if (typeof impl[prop] !== 'function') throw new Error(`service "${service}" (plugin ${label}) has no method "${String(prop)}"`)
          return structuredClone(await impl[prop](...structuredClone(args)))
        }
      },
    }
  )
}

function fakeServices(ctx, opts) {
  const providers = new Map()
  const eventListeners = []
  const changeListeners = []
  let changeQueued = false
  const changed = () => {
    if (changeQueued) return
    changeQueued = true
    queueMicrotask(() => {
      changeQueued = false
      for (const fn of changeListeners) fn()
    })
  }
  ctx.addProvider = (pluginId, feed) => {
    providers.set(pluginId, feed)
    changed()
  }
  ctx.removeProvider = (pluginId) => {
    providers.delete(pluginId)
    changed()
  }
  ctx.emitFeed = (pluginId, event, data = {}) => {
    for (const l of eventListeners) if (l.event === event) queueMicrotask(() => l.fn(structuredClone(data), pluginId))
  }
  const services = {
    useAll(name) {
      if (name !== 'inbox-feed') throw new Error(`plugin bronos.autopilot does not declare service "${name}" in services.collects`)
      return Object.freeze({
        providers: () => [...providers.keys()].map((pluginId) => ({ pluginId, handle: handleOf(() => providers.get(pluginId)?.impl, pluginId, 'inbox-feed') })),
        on: (event, fn) => {
          const l = { event, fn }
          eventListeners.push(l)
          return () => eventListeners.splice(eventListeners.indexOf(l), 1)
        },
        onChange: (fn) => {
          changeListeners.push(fn)
          return () => changeListeners.splice(changeListeners.indexOf(fn), 1)
        },
      })
    },
    use(name) {
      if (name !== 'jev') throw new Error(`plugin bronos.autopilot does not declare service "${name}" in services.uses`)
      return handleOf(() => ctx.jev && ctx.jev.impl, 'bronos.jev', 'jev')
    },
    available: (name) => (name === 'jev' ? Boolean(ctx.jev) : name === 'inbox-feed' && providers.size > 0),
    provide() {
      throw new Error('Autopilot provides nothing')
    },
    emit() {
      throw new Error('Autopilot provides nothing')
    },
    caller: () => undefined,
  }
  if (opts.old) delete services.useAll
  return services
}

/** The per-project store (ctx.storage). */
function fakeStorage() {
  const store = new Map()
  return {
    map: store,
    async get(k) {
      return store.has(k) ? structuredClone(store.get(k)) : undefined
    },
    async set(k, v) {
      if (typeof k !== 'string' || !k || k.length > 200) throw new Error(`bad storage key ${k}`)
      if (JSON.stringify(v).length > 1024 * 1024) throw new RangeError('value over 1 MiB')
      store.set(k, structuredClone(v))
    },
    async delete(k) {
      store.delete(k)
    },
    async keys() {
      return [...store.keys()]
    },
  }
}

/**
 * The app-wide store (ctx.appStorage): like ctx.storage, plus `increment`, atomic as main's (read and
 * write in one step, no await between), so two hosts sharing one store race the way two windows do.
 * `calls` counts every call (the claims' cost); `failing`: every call rejects (main gone).
 */
function fakeAppStorage() {
  const st = fakeStorage()
  st.calls = 0
  st.failing = false
  for (const name of ['get', 'set', 'delete', 'keys']) {
    const f = st[name].bind(st)
    st[name] = async (...a) => {
      st.calls++
      if (st.failing) throw new Error('appStorage is not answering')
      return f(...a)
    }
  }
  st.increment = async (k, by = 1) => {
    st.calls++
    if (st.failing) throw new Error('appStorage is not answering')
    const cur = st.map.has(k) ? st.map.get(k) : 0
    if (typeof cur !== 'number') throw new TypeError(`${k} is not a number`)
    st.map.set(k, cur + by)
    return cur + by
  }
  return st
}

/**
 * A clock for `now` and the timers together: `advance(ms)` moves the time and runs every timer due,
 * in order. Nothing runs on its own.
 */
function fakeClock(t = NOW) {
  let seq = 0
  const pending = new Map()
  const clock = {
    t,
    now: () => clock.t,
    timers: {
      setTimeout(fn, ms) {
        const id = ++seq
        pending.set(id, { at: clock.t + Math.max(0, ms || 0), fn })
        return id
      },
      clearTimeout(id) {
        pending.delete(id)
      },
    },
    pending: () => pending.size,
    /** Move the time on by `ms`, running each timer that falls due (and letting its promises settle). */
    async advance(ms) {
      const end = clock.t + ms
      for (;;) {
        const due = [...pending.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
        if (!due.length) break
        const [id, { at, fn }] = due[0]
        pending.delete(id)
        clock.t = Math.max(clock.t, at)
        fn()
        await settle()
      }
      clock.t = end
      await settle()
    },
  }
  return clock
}

/**
 * A ctx good enough for dist/host.js. `opts.old`: an app before 0.9.7 (no `useAll`); `opts.noTyped`: an
 * app before 0.11 (no `SessionInfo.typed`); `opts.settings`: more project settings beside the folder.
 * `opts.folder` is the PROJECT rules folder (`projectFolder`); `opts.globalFolder` the app setting
 * `globalFolder`, '' (no global rules) unless given, so no test ever reads the real
 * ~/.config/cc-cockpit-autopilot. `opts.globalDefault`: leave `globalFolder` unset (the default path,
 * under the test's own `home`).
 */
function fakeCtx(opts = {}) {
  const panelListeners = []
  const actionListeners = []
  const settingsListeners = []
  const ctx = {
    api: 1,
    pluginId: 'bronos.autopilot',
    projectDir: opts.projectDir || '/work/project',
    settings: Object.freeze({
      project: Object.freeze({ ...(opts.folder !== undefined ? { projectFolder: opts.folder } : {}), ...(opts.settings || {}) }),
      app: Object.freeze(opts.globalDefault ? {} : { globalFolder: opts.globalFolder === undefined ? '' : opts.globalFolder }),
    }),
    posts: [],
    headers: [],
    badges: [],
    logs: [],
    notes: [],
    opened: [],
    schedules: [],
    jev: opts.jev || null,
    openError: null,
    storage: opts.storage || fakeStorage(),
    appStorage: opts.appStorage || fakeAppStorage(),
    log: {
      info: (...a) => ctx.logs.push(['info', a.join(' ')]),
      warn: (...a) => ctx.logs.push(['warn', a.join(' ')]),
      error: (...a) => ctx.logs.push(['error', a.join(' ')]),
    },
    badge: (panel, v) => ctx.badges.push(v),
    schedule(seconds, fn) {
      const s = { seconds, fn, stopped: false }
      ctx.schedules.push(s)
      return () => {
        s.stopped = true
      }
    },
    async notify(text, o) {
      if (typeof text !== 'string') throw new TypeError('text')
      ctx.notes.push({ text, opts: o === undefined ? undefined : structuredClone(o) })
      return { clicked: false }
    },
    sessions: {
      async open(o) {
        // As the app: the prompt may not start with a command character; cwd inside the project.
        if (ctx.openError) throw new Error(ctx.openError)
        if (typeof o.prompt === 'string' && /^[/!#&]/.test(o.prompt)) throw new Error('prompt may not start with /, !, # or &')
        if (o.cwd && !(o.cwd === ctx.projectDir || o.cwd.startsWith(`${ctx.projectDir}/`))) throw new Error('cwd outside the project')
        if (ctx.openHold) {
          const gate = ctx.openHold
          ctx.openHold = null
          await gate
        }
        ctx.opened.push(structuredClone(o))
        const tabId = `tab-${ctx.opened.length}`
        // As 0.11: the new tab is in the list at once, `starting`, no sessionId until its SessionStart
        // hook, `typed: false` (an older app has no `typed`: `opts.noTyped`). The app's onChange for the
        // new tab comes a moment later; a test moves the tab on with `setSession`.
        ctx.sessionList.push({ tabId, status: 'starting', cwd: o.cwd || ctx.projectDir, ...(opts.noTyped ? {} : { typed: false }) })
        queueMicrotask(() => ctx.emitSessions())
        return { tabId }
      },
      // As 0.11 main: an unknown tab or a text starting with a command character rejects, and so does
      // a tab the person typed in ("the person is typing in this tab"); otherwise the text is accepted
      // (typed now or queued by the send gate). `ctx.sendError` makes the next send reject.
      async send(tabId, text) {
        const s = ctx.sessionList.find((x) => x.tabId === tabId)
        if (ctx.sendError) {
          const m = ctx.sendError
          ctx.sendError = null
          throw new Error(m)
        }
        if (!s) throw new Error('unknown tab')
        if (typeof text !== 'string' || /^[/!#&]/.test(text)) throw new Error('text may not start with /, !, # or &')
        if (s.typed === true) throw new Error('the person is typing in this tab')
        ctx.sent.push({ tabId, text, status: s.status })
      },
      list: async () => structuredClone(ctx.sessionList),
      onChange(fn) {
        ctx.sessionListeners.push(fn)
        return () => ctx.sessionListeners.splice(ctx.sessionListeners.indexOf(fn), 1)
      },
    },
    // The window's Claude tabs (SessionInfo: tabId, status, cwd, sessionId?, typed) and their listeners.
    sessionList: [],
    sessionListeners: [],
    sent: [],
    sendError: null,
    openHold: null,
    /** Make the next open() wait until the returned `release()` (an open still in flight). */
    holdOpen() {
      let release
      ctx.openHold = new Promise((r) => (release = r))
      return () => release()
    },
    /** Change a tab (`patch` over its SessionInfo) and tell the onChange listeners, as the app does. */
    setSession(tabId, patch) {
      const s = ctx.sessionList.find((x) => x.tabId === tabId)
      if (!s) throw new Error(`no tab ${tabId}`)
      Object.assign(s, patch)
      ctx.emitSessions()
    },
    /** Add a Claude tab the plugin did not open (a restored one, the person's own). */
    addSession(info) {
      ctx.sessionList.push({ status: 'waiting', cwd: ctx.projectDir, typed: false, ...info })
      ctx.emitSessions()
    },
    /** The person closed a tab. */
    closeTab(tabId) {
      ctx.sessionList = ctx.sessionList.filter((x) => x.tabId !== tabId)
      ctx.emitSessions()
    },
    emitSessions() {
      for (const fn of ctx.sessionListeners) fn(structuredClone(ctx.sessionList))
    },
    panels: {
      post: (panel, m) => {
        if (JSON.stringify(m).length > 1024 * 1024) throw new Error('panel message over 1 MiB')
        ctx.posts.push(structuredClone(m))
      },
      onMessage: (panel, fn) => {
        panelListeners.push(fn)
        return () => {}
      },
      header: (panel, spec) => {
        if (spec && spec.meta && spec.meta.length > 120) throw new TypeError('meta over 120')
        ctx.headers.push(structuredClone(spec))
      },
      onAction: (panel, fn) => {
        actionListeners.push(fn)
        return () => {}
      },
      show() {},
    },
    onSettingsChange(fn) {
      settingsListeners.push(fn)
      return () => {}
    },
    /** New settings, as the app sends them: `project` replaced, `app` kept unless given. */
    setSettings(project, app) {
      ctx.settings = Object.freeze({ project: Object.freeze(project), app: Object.freeze(app === undefined ? { ...ctx.settings.app } : app) })
      for (const fn of settingsListeners) fn(ctx.settings)
    },
    async sendPanel(m) {
      for (const fn of panelListeners) await fn(structuredClone(m))
    },
    clickAction(id) {
      for (const fn of actionListeners) fn(id)
    },
    cli: {
      register: (name, fn) => {
        ctx.cliName = name
        ctx.cliHandler = fn
        return () => {}
      },
    },
    /** `tabId`: the Claude tab that ran `ccc` (CliCall.tabId, app 0.11); absent like a shell tab's call. `stdin`: what the app read (only for a `-` argument). */
    async runCli(argv, tabId, stdin = '') {
      return ctx.cliHandler(argv, { stdin, cwd: '/tmp', signal: new AbortController().signal, ...(tabId !== undefined ? { tabId } : {}) })
    },
    lastState() {
      return [...ctx.posts].reverse().find((m) => m.type === 'state')
    },
  }
  ctx.services = fakeServices(ctx, opts)
  return ctx
}

/** Let queued microtasks and promise continuations run. */
const flush = () => new Promise((r) => setImmediate(r))
async function settle() {
  for (let i = 0; i < 20; i++) await flush()
}

/**
 * Await `p` while running the fake clock's timers due now (lib/jev.js's lane timer): the work before
 * the timer is armed reads real files, so one settle is not always enough. At most 200 rounds.
 */
async function drive(clock, p) {
  let done = false
  const out = p.finally(() => (done = true))
  for (let i = 0; i < 200 && !done; i++) {
    await clock.advance(0)
    await new Promise((r) => setTimeout(r, 1))
  }
  return out
}

/**
 * A temp rules folder: `rules` (an array, or a string written as is) in autopilot-rules.json and
 * `playbooks` { name: text }. `v1`: also a v1 rules.json with that text (never read by v2).
 */
function tempFolder(rules, playbooks = {}, v1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-test-'))
  if (rules !== undefined) fs.writeFileSync(path.join(dir, RULES_FILE), typeof rules === 'string' ? rules : JSON.stringify(rules, null, 2))
  if (v1 !== undefined) fs.writeFileSync(path.join(dir, 'rules.json'), v1)
  fs.mkdirSync(path.join(dir, 'playbooks'))
  for (const [name, text] of Object.entries(playbooks)) fs.writeFileSync(path.join(dir, 'playbooks', `${name}.md`), text)
  return dir
}
const removeFolder = (dir) => fs.rmSync(dir, { recursive: true, force: true })

/** A valid rule, with overrides. */
function rule(id, o = {}) {
  return {
    id,
    sources: ['*'],
    when: [{ field: 'title', op: 'contains', value: 'down' }],
    check: 'The item reports that a site is down.',
    playbook: 'check',
    ...o,
  }
}

module.exports = { NOW, MIN, HOUR, RULES_FILE, item, bare, fakeFeed, fakeJev, fakeStorage, fakeAppStorage, fakeClock, fakeCtx, flush, settle, drive, tempFolder, removeFolder, rule, CHAT, MAIL, JIRA }
