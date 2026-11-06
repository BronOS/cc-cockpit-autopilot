'use strict'
// Autopilot (bronos.autopilot): watches every `inbox-feed` provider and, when an item matches one of
// the person's rules, opens a Claude tab that investigates it with the person's playbook
// (docs/design.md; its "v1 scope" decides where the earlier sections differ).
//
// The ladder per new or changed item (design-v2 "Architecture", "Rules"): the rules in order, each
// checked cheapest first (enabled, sources, hours, field conditions, Jev; lib/match.js `evaluate`), and
// the FIRST rule that holds is the item's rule; the rules below it that would hold too are logged as
// "also matched" and never run. A pending Jev answer holds the item's decision (lower rules do not
// fire meanwhile) until lib/jev.js hands it back; Jev unavailable is a retry in 10 minutes, never a
// fall-through. Then: once per rev -> limits (per rule per day, cooldown, 10 an hour for all rules)
// -> ctx.sessions.open with the fixed frame, the fenced item and the playbook -> log and notification.
// A limit or a refused open of the item's rule does not hand the item to a lower rule either.
//
// Never a burst: an item fires only when it appears or changes AFTER a baseline. Each source's first
// good read is its baseline (at start, when a provider joins, after a source that answered nothing
// first), and switching Autopilot on re-takes the baseline of every source, so items that came in
// while it was off never fire. While off the items are still tracked (so the baseline is always
// current) and the dry run still works; nothing is asked of Jev and nothing opens.
//
// Feed v2 (lib/sources.js): sources push `item` / `gone` / `sync`; the store keeps the baseline and
// hands over the news. A provider joining or leaving syncs the set; every 60 s a source whose snapshot
// failed is read again. Each provider call has a time limit; one source that throws or hangs never
// holds the others. News is judged one batch at a time (a queue), so one item is never judged twice
// at once.
//
// One session per item (lib/runs.js, design-v2 "One session per item"): a fire first puts an opening
// entry for the item, then opens the tab and records item -> tab in ctx.storage. While the tab exists
// the item never opens a second one; once the person closes it the item is free. A new rev meanwhile
// is, for an `onChange` rule, the item's one pending update (newest wins), typed into the tab through
// the send gate when Claude waits there and the person has not typed in it; never after the person
// typed (taken over), 5 deliveries, or the session's `ccc autopilot stop <run>` (accepted only from
// that run's own tab); the person's own reply (`myNames`) is logged, not delivered. At most `maxRunning` tabs hold a slot (opening, starting or
// working); a fire at the cap queues the item, re-decided from the top with its latest copy when a slot
// frees. The run check reads ctx.sessions.list() before each batch of decisions and on every onChange.
//
// Rule and playbook management (lib/manage.js): the panel posts an edit, the host checks it with the
// loader's own rules and writes the file (atomic, never through a link, never over a hand edit it
// has not read), then reads the folders again and publishes. Writes run one at a time.
//
// One window per item (lib/claims.js, design-v2 "One window per item"): before it opens or queues an
// item, a window claims it app-wide in ctx.appStorage; the window that loses logs "running in another
// window" and neither opens nor queues it. Only the owner delivers updates into the item's tab. The
// claim is released when the tab ends or closes, the item leaves the queue, its rule is switched off
// or deleted, an open fails, and at deactivate; the owner refreshes it every 10 min, and another
// window frees one that went stale (3 h by the clock and 30 of its own passes watching it).
//
// Two rule levels (lib/rules.js, design-v2 "Two rule levels"): the project's folder and the global
// one, each with its own autopilot-rules.json and playbooks/. Project rules are checked first, then
// global ones; the first that holds wins. A rule is named `<level>:<id>` (its `ref`) in the log, the
// runs, the fired and limit records and the prompt frame, since an id is unique per level only. Every
// edit names its level; a playbook resolves in its rule's own level.
//
// 0.3.0 (design-v2 "Autopilot 0.3.0"): an ACT rule runs one of the item's own feed actions (markRead,
// done, ...) through the same inbox-feed service the items come from: no tab, no prompt, no Claude, so
// outside text reaches no model and there is nothing to inject into. It fires on new items only, needs
// the action in the item's current `actions` (else it is a non-match and the next rule may take the
// item), goes through the limits and the app-wide claim like a session rule, holds the claim only while
// the action runs, and counts against its limits only when the source says ok. A session rule has a
// `mode` (investigate, or act: the playbook's "Allowed actions" only), and every session prompt carries
// the person's base.md (both levels) after the fixed frame, before the fenced item (lib/prompt.js).

const crypto = require('node:crypto')
const os = require('node:os')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { text } = require('./lib/feed')
const { createSources } = require('./lib/sources')
const R = require('./lib/rules')
const S = require('./lib/schema')
const { matchRule, evaluate, outsiderWarning } = require('./lib/match')
const { createJev } = require('./lib/jev')
const { newMarker, newRunId, buildPrompt, deliveryText } = require('./lib/prompt')
const { createState } = require('./lib/state')
const RUNS = require('./lib/runs')
const { createClaims } = require('./lib/claims')
const CLI = require('./lib/cli')
const M = require('./lib/manage')
const F = require('./lib/format')

const PANEL = 'main'
const FEED = 'inbox-feed'
const JEV = 'jev'
const CALL_MS = 10000
// Jev answers other windows cached are read this often (every answer is its own appStorage key, so a
// full read is one call per key: not on every 60 s pass). This window's own answers are in memory.
const JEV_LOAD_MS = 10 * 60000
// The dry run waits this long for the Jev answers it asked (the plugin command limit is 30 s; lib/jev.js
// has its own 45 s call limit, past which the answer is "unavailable" anyway).
const DRY_JEV_MS = 20000
// How long `ccc autopilot` waits for the first refresh (the plugin command limit is 30 s).
const CLI_WAIT_MS = 15000
const DEBOUNCE_MS = 1000
const REFRESH_S = 60
// The dry run asks Jev at most this often (each ask is a paid request and the CLI has 30 s).
const DRY_JEV_MAX = 10
const DRY_MAX = 100
const EXAMPLES_DIR = path.join(__dirname, '..', 'examples')
// An app before 0.11 drops sessions.open's model and effort without a word (design-v2 "Shipped details").
const MODEL_NOTE = 'model and effort need cc-cockpit 0.11: this app ignores them and starts the session with your default'
const OLD_APP = 'Autopilot needs cc-cockpit 0.9.7 or newer (ctx.services.useAll). Update the app.'

const why = (e) => String((e && e.message) || e || 'failed').slice(0, 300)

/** `p`, or a rejection after `ms` (a provider that never answers must not hold the refresh). */
function withTimeout(p, ms, what, timers) {
  let t
  return Promise.race([
    Promise.resolve(p).finally(() => timers.clearTimeout(t)),
    new Promise((_, reject) => {
      t = timers.setTimeout(() => reject(new Error(`${what} did not answer in ${Math.round(ms / 1000)} s`)), ms)
    }),
  ])
}

/**
 * An in-memory stand-in for ctx.appStorage on an app without it: Jev answers then last one host run,
 * and claims guard this window only (the useAll check above already refuses an app that old).
 */
function memoryStore() {
  const m = new Map()
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    keys: async () => [...m.keys()],
    increment: async (k, by = 1) => {
      const v = (typeof m.get(k) === 'number' ? m.get(k) : 0) + by
      m.set(k, v)
      return v
    },
  }
}

/**
 * The Autopilot host. `opts` exists for tests: `now` (clock), `timers` ({ setTimeout, clearTimeout }
 * for the debounce, the call limits and lib/jev.js), `callMs`, `debounceMs`, `cliWaitMs`, `dryJevMs`,
 * `fs` (the fs/promises API), `home` (for `~`), `randomBytes` (the marker's source).
 */
function createAutopilot(ctx, opts = {}) {
  const now = opts.now || Date.now
  const timers = opts.timers || { setTimeout, clearTimeout }
  const callMs = opts.callMs ?? CALL_MS
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS
  const fs = opts.fs || fsp
  const home = opts.home || os.homedir()
  const randomBytes = opts.randomBytes || crypto.randomBytes
  const examplesDir = opts.examplesDir || EXAMPLES_DIR
  const disposers = []

  if (typeof ctx.services.useAll !== 'function') {
    // The manifest's `services.collects` keeps Autopilot off an older app; this is the belt to that.
    ctx.log.warn(OLD_APP)
    disposers.push(ctx.panels.onMessage(PANEL, () => ctx.panels.post(PANEL, { type: 'state', fatal: OLD_APP })))
    return { first: Promise.resolve(), tick: async () => {}, act: async () => {}, dispose: () => disposers.forEach((d) => d()) }
  }

  const feeds = ctx.services.useAll(FEED)
  const state = createState(ctx.storage)
  const runs = RUNS.createRuns({ storage: ctx.storage, now })
  const maxRunning = () => RUNS.maxRunningOf(ctx.settings)
  /** A level's folder from the settings now (null: that level has no rules here). */
  const folderOf = (level) => R.levelFolder(level, ctx.settings, home, ctx.projectDir).folder
  const emptyLoad = (problems = []) => ({ levels: { project: null, global: null }, rules: [], problems, hints: [] })
  /**
   * The last read of both folders (rules.js loadLevels): `{ levels: { project, global }, rules,
   * problems, hints }`; a level is null without a folder, else `{ level, folder, rules, problems, hint,
   * playbooks, folderState, raw, hash, entries, playbookFiles }`. A level's `hash` is the content hash
   * the host last read of its file: a rules write that names another one is refused.
   */
  let loaded = emptyLoad()
  const levelOf = (level) => (S.LEVELS.includes(level) ? loaded.levels[level] : null)
  /** The rule a ref names now (`project:r1`), or null. */
  const ruleByRef = (ref) => loaded.rules.find((r) => r.ref === ref) || null
  let lastDry = null
  let disposed = false
  let ticking = null
  let queue = Promise.resolve()

  const call = (p, what) => withTimeout(p, callMs, what, timers)
  const warn = (what) => (e) => ctx.log.warn(`${what}: ${why(e)}`)
  // The app-wide store (main's, shared by every window): the Jev cache and the claims. Each claim call
  // has the call limit, so a main that stops answering fails the claim (closed: no tab) and never
  // holds the judging queue.
  const appStore = ctx.appStorage || memoryStore()
  const claimStore = {
    get: (k) => call(appStore.get(k), 'appStorage'),
    set: (k, v) => call(appStore.set(k, v), 'appStorage'),
    delete: (k) => call(appStore.delete(k), 'appStorage'),
    keys: () => call(appStore.keys(), 'appStorage'),
    increment: (k, by) => call(appStore.increment(k, by), 'appStorage'),
  }
  const claims = createClaims({ store: claimStore, project: ctx.projectDir, now })
  /** Run `fn` after every earlier queued job: item judging is one at a time. */
  function enqueue(fn) {
    const job = queue.then(fn)
    queue = job.catch(() => {})
    return job
  }

  // ---- the rules folder ----

  async function reloadRules() {
    try {
      loaded = await R.loadLevels(ctx.settings, { home, projectDir: ctx.projectDir, fs, list: M.listPlaybooks })
    } catch (e) {
      // loadLevels answers problems itself; this is the belt for a bug in it.
      loaded = emptyLoad([`reading the rules folders failed: ${why(e)}`])
    }
    return loaded
  }

  /**
   * What evaluate needs besides the rules and the item: the provider's kind, the clock and the Jev
   * answers. `jevAnswer` may queue a request (the live path); the dry run passes its own.
   */
  // `live`: the item's newness from the store (an act rule fires on new items only); the dry run leaves
  // it out, so every current item is judged as if it had just come in (its question is "would it fire").
  const evalOpts = (jevAnswer, live = false) => ({ kindOf, now: now(), jevAnswer, jevCached: jev.cached, ...(live ? { isNew: (pluginId, it) => store.isNew(pluginId, it.id, it.rev) } : {}) })
  const kindOf = (pluginId) => {
    const s = store.get(pluginId)
    return s ? s.desc.kind : null
  }
  /**
   * A rule's warnings now: the outsider-trigger warning, what rules.js dropped, and the model note
   * when a Claude tab of this window shows the app has no `typed` (so no model/effort either; while
   * no tab exists it is unknown and not claimed).
   */
  function warningsOf(rule) {
    const w = outsiderWarning(rule, kindOf)
    const out = w ? [w, ...rule.warnings] : [...rule.warnings]
    if ((rule.model || rule.effort) && runs.support() === 'no') out.push(MODEL_NOTE)
    return out
  }

  // ---- sources ----

  // The store (lib/sources.js) owns the providers, their snapshots and events, the baseline and the
  // news; the host only judges the news. It keeps tracking while Autopilot is off (so the baseline is
  // always current) and judges only while it is on.
  const store = createSources(feeds, {
    log: ctx.log,
    timers,
    callMs,
    onChange: () => schedulePublish(),
    onNews: (pluginId, items) => onNews(pluginId, items),
  })

  /** The sources as the panel, the dry run and the status read them: `{ pluginId, desc, items, error }`. */
  function sourceList() {
    return store.list().map((r) => ({
      pluginId: r.pluginId,
      desc: r.desc,
      items: r.items,
      error: r.error || (r.state === 'ok' ? null : `${r.desc.label}: ${r.message || (r.state === 'signedOut' ? 'signed out' : 'error')}`),
    }))
  }

  /** New or changed items after the baseline (store.onNews): judged one batch at a time, only while on. */
  function onNews(pluginId, items) {
    if (disposed || !state.enabled()) return
    void enqueue(async () => {
      if (disposed || !state.enabled()) return
      await judge(pluginId, items)
      publish()
    }).catch(warn('judge'))
  }

  // A state change comes with every event: one publish per quiet moment, not one per event.
  let publishTimer = null
  function schedulePublish() {
    if (disposed || publishTimer) return
    publishTimer = timers.setTimeout(() => {
      publishTimer = null
      publish()
    }, debounceMs)
  }

  // ---- judging ----

  async function log(entry) {
    await state.append(entry).catch(warn('log'))
  }

  // ---- the app-wide claims (lib/claims.js) ----

  /** Release the item's claim if this window holds it; a store error is logged (the claim then goes stale). */
  async function releaseClaim(source, itemId) {
    try {
      return await claims.release(source, itemId)
    } catch (e) {
      ctx.log.warn(`claim release: ${why(e)}`)
      return false
    }
  }

  /** Take an item out of the queue for any reason but opening it: its claim goes with it. */
  async function dequeue(source, itemId) {
    if (runs.unqueue(source, itemId) && !runs.runOf(source, itemId)) await releaseClaim(source, itemId)
  }

  /**
   * The belt to every release point (run inside the judging queue, after a batch, a pass or a
   * sessions change): a claim this window holds must be backed by a run (opening or a tab that has not
   * ended) or a queue entry, and its rule must still be on. A rule that is off, or gone from a level
   * whose file was read fine, releases it (a folder that failed to read releases nothing: the
   * cautious side is to keep a claim, never to open a second tab). A queued item of such a rule
   * leaves the queue too.
   */
  async function settleClaims() {
    for (const c of claims.owned()) {
      const run = runs.runOf(c.source, c.itemId)
      const ended = run && run.kind === 'tab' && run.tab && run.tab.status === 'ended'
      const [level] = c.rule.split(':')
      const lv = levelOf(level)
      const rule = ruleByRef(c.rule)
      const ruleOff = rule ? rule.enabled === false : Boolean(lv && lv.folderState === 'ok' && Array.isArray(lv.raw))
      if ((run && !ended) || runs.isQueued(c.source, c.itemId)) {
        if (!ruleOff) continue
        runs.unqueue(c.source, c.itemId)
      }
      await releaseClaim(c.source, c.itemId)
    }
  }

  /**
   * At start, after the run records loaded: each record's item is claimed again under the record's
   * own run id. The claim a quit left is this window's (same project and run id) and is kept; none
   * is a fresh claim; another window's live claim (it opened the item meanwhile) is logged, and
   * nothing is delivered into this tab.
   */
  async function adoptClaims() {
    for (const r of runs.list()) {
      const entry = (note) => log({ at: now(), rule: r.rule, source: r.source, itemId: r.itemId, title: '', step: 'claim', note })
      if (!r.runId) {
        await entry(`tab ${r.tabId}: the record has no run id, so its claim cannot be kept; nothing is delivered into it`)
        continue
      }
      try {
        const c = await claims.claim({ source: r.source, itemId: r.itemId, runId: r.runId, rule: r.rule }, { adopt: true })
        if (!c.ok) await entry(`tab ${r.tabId}: the item is claimed by another window${c.owner ? ` (${CLI.oneLine(c.owner.project, 200)})` : ''}; nothing is delivered into this tab`)
      } catch (e) {
        await entry(`tab ${r.tabId}: the claim could not be read (${why(e)}); nothing is delivered into it until a later pass`)
      }
    }
  }

  /** The claims' 60 s pass (lib/claims.js tick): refresh, the sweep, and the log of what changed. */
  async function claimsPass() {
    const out = await claims.tick()
    for (const l of out.lost) await log({ at: now(), rule: l.rule, source: l.source, itemId: l.itemId, title: '', step: 'claim', note: `the item's claim went to another window${l.owner ? ` (${CLI.oneLine(l.owner.project, 200)})` : ''}: nothing more is delivered from here` })
    for (const f of out.freed) await log({ at: now(), rule: f.rule, source: f.source, itemId: f.itemId, title: '', step: 'claim', note: `freed a stale claim of ${CLI.oneLine(f.project, 200)} (not refreshed since ${new Date(f.seen).toISOString().slice(0, 16).replace('T', ' ')} UTC)` })
    for (const e of out.errors) ctx.log.warn(`claims: ${why(e)}`)
  }

  // A rule is named by its ref in every entry: an id alone could be either level's.
  const itemOfEntry = (rule, s, it) => ({ rule: rule.ref, source: s.pluginId, itemId: it.id, title: text(it.title, 200) || '' })

  /**
   * The rule's session for an item `evaluate` gave it (`ev`: decision `fire`): true when a session
   * opened. Hours and Jev were checked by `evaluate`; what is left are the limits and the open. Each
   * skip worth seeing is a log entry naming the step that decided; the fire's entry names the rules
   * that also matched (design-v2: logged, never run).
   */
  async function tryRule(ev, pluginId, it) {
    if (ev.rule.act) return tryAct(ev, pluginId, it)
    const { rule, score } = ev
    const base = itemOfEntry(rule, { pluginId }, it)
    const step = rule.jev ? 'jev' : 'rule'
    const scored = score !== undefined ? { score } : {}
    const also = ev.also.length ? { also: ev.also.map((a) => a.rule.ref) } : {}
    // Switched off while Jev answered: nothing fires.
    if (!state.enabled() || disposed) return false
    const t = now()
    const limit = state.limitReason(rule, t)
    if (limit) {
      await log({ at: t, ...base, step: 'limit', ...scored, ...also, skip: limit })
      return false
    }
    // The playbook of the rule's own level (a global rule never reads a project's playbooks/).
    const lv = levelOf(rule.level)
    const pb = lv && lv.playbooks.get(rule.playbook)
    if (!pb) {
      await dequeue(pluginId, it.id)
      await log({ at: t, ...base, step: 'open', ...also, skip: `playbook ${rule.playbook} not loaded (${rule.level} folder)` })
      return false
    }
    // A base.md that is there but cannot be used opens no session (rules.js readBase): the person's
    // standing instructions may be the very limits they count on, so a session without them is not
    // the session they set up. Not queued either; the next news after the fix is decided again.
    const baseBad = S.LEVELS.map((l) => levelOf(l)).find((l) => l && l.baseProblem)
    if (baseBad) {
      await dequeue(pluginId, it.id)
      await log({ at: t, ...base, step: 'open', ...also, skip: `the ${baseBad.level} ${S.BASE_FILE} cannot be used (${baseBad.baseProblem}); no session opens until it is fixed` })
      return false
    }
    // The app-wide claim before the cap: a window that loses neither opens nor queues the item, so
    // two windows never both hold it, and a queued item already owns it when its slot frees. A queued
    // item opens under the run id it was claimed (and queued) with.
    const queued = runs.queuedOf(pluginId, it.id)
    const runId = (queued && queued.runId) || newRunId(randomBytes)
    let won
    try {
      won = await claims.claim({ source: pluginId, itemId: it.id, runId, rule: rule.ref })
    } catch (e) {
      // Fail closed: without a claim a second window could open the same item.
      await dequeue(pluginId, it.id)
      await log({ at: t, ...base, step: 'claim', ...also, skip: `the app-wide claim failed: ${why(e)}; not opened` })
      return false
    }
    if (!won.ok) {
      runs.unqueue(pluginId, it.id)
      const o = won.owner
      const who = o ? ` (${CLI.oneLine(o.project, 200)}, ${CLI.oneLine(o.rule, 80) || 'a rule'}, since ${new Date(o.at).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : ''
      await log({ at: t, ...base, step: 'claim', ...also, skip: `running in another window${who}: not opened here, not queued` })
      return false
    }
    if (won.took) await log({ at: t, ...base, step: 'claim', note: `took over a stale claim of ${CLI.oneLine(won.took.project, 200)} (not refreshed since ${new Date(won.took.seen).toISOString().slice(0, 16).replace('T', ' ')} UTC)` })
    // The cap after the limits (a run a limit refuses is logged and never queued, design-v2 "Limits").
    // A queued item keeps its place; its latest copy is decided again from the top when a slot frees.
    const max = maxRunning()
    const busy = runs.running()
    if (busy >= max) {
      const isNew = !queued
      const out = runs.enqueue(pluginId, it.id, runId)
      if (out) {
        await releaseClaim(out.source, out.itemId)
        await log({ at: t, rule: rule.ref, source: out.source, itemId: out.itemId, title: '', step: 'cap', skip: `dropped from the queue: it is full (${RUNS.QUEUE_MAX} items), this was the oldest` })
      }
      if (isNew) await log({ at: t, ...base, step: 'cap', ...also, skip: `queued: ${busy} Autopilot sessions running (maxRunning ${max}); opens when one finishes` })
      return false
    }
    runs.unqueue(pluginId, it.id)
    let prompt
    try {
      prompt = buildPrompt({ rule, pluginId, item: it, playbook: pb.body, base: baseTexts(), marker: newMarker(randomBytes), runId })
    } catch (e) {
      await releaseClaim(pluginId, it.id)
      await log({ at: t, ...base, step: 'open', skip: why(e) })
      return false
    }
    let tabId
    // The opening entry: until open() resolves the item has a run (nothing opens it twice) and holds a slot.
    runs.beginOpening(pluginId, it.id, { rule: rule.ref, rev: it.rev, runId })
    try {
      // model and effort only when the rule names them (absent: the person's default). An app before
      // 0.11 drops them silently; the rule then shows MODEL_NOTE once a Claude tab tells (warningsOf).
      const r = await ctx.sessions.open({ cwd: ctx.projectDir, prompt, ...(rule.model ? { model: rule.model } : {}), ...(rule.effort ? { effort: rule.effort } : {}) })
      tabId = r && typeof r.tabId === 'string' ? r.tabId : '?'
      await runs.record({ source: pluginId, itemId: it.id, tabId, rule: rule.ref, rev: it.rev, openedAt: t, runId, mode: rule.mode === 'act' ? 'act' : 'investigate' }).catch(warn('runs'))
    } catch (e) {
      // The app's own limit (5 a minute), a window closing, a refused prompt, a model the app refused.
      // No tab: the claim goes too, so another window (or this one, on the next rev) may open it.
      await releaseClaim(pluginId, it.id)
      await log({ at: now(), ...base, step: 'open', ...also, skip: `open refused: ${why(e)}` })
      return false
    } finally {
      runs.endOpening(pluginId, it.id)
    }
    await state.markFired(rule.ref, pluginId, it.id, it.rev, t).catch(warn('state'))
    await state.recordOpen(rule.ref, t).catch(warn('state'))
    await log({ at: t, ...base, step, ...scored, ...also, tabId, runId })
    // Not awaited: notify resolves when shown, and judging must not wait for it.
    ctx.notify(`Autopilot: ${rule.ref} for ${CLI.oneLine(it.title, 200)}`, { title: 'Autopilot' }).catch(warn('notify'))
    return true
  }

  /** The levels' base.md texts for a prompt: global first, then project (design-v2 "base.md"). */
  const baseTexts = () => ['global', 'project'].map((l) => levelOf(l)).filter((l) => l && l.base).map((l) => ({ level: l.level, text: l.base.text }))

  /** What the log says an action did: "marked read: <title>" for the well-known ids, else "ran <label>". */
  function actDone(action, it) {
    const known = { markRead: 'marked read', markUnread: 'marked unread', done: 'marked done at the source' }
    const a = (it.actions || []).find((x) => x.id === action)
    const what = known[action] || `ran ${CLI.oneLine(a ? a.label : action, 40)} (${action})`
    return `${what}: ${text(it.title, 200) || it.id}`
  }

  /**
   * An act rule fired (`ev`, decision `fire`; evaluate checked that the item is new and that the action
   * is among its actions now): the limits, the app-wide claim (so two windows never both act, and an
   * item another window has a session on is left to it), the source's `act`, the release, the log.
   * Counted against the limits (and marked fired) only when the source answered ok; a failure is
   * logged with the source's own message and does not hand the item to a lower rule (the rule did hold).
   * No cap, no queue (no tab holds a slot) and no notification (a rule that marks mail read exists so
   * the person is not interrupted by that mail). Resolves true when the action ran.
   */
  async function tryAct(ev, pluginId, it) {
    const { rule, score } = ev
    const base = { ...itemOfEntry(rule, { pluginId }, it), act: rule.act }
    const scored = score !== undefined ? { score } : {}
    const also = ev.also.length ? { also: ev.also.map((a) => a.rule.ref) } : {}
    if (!state.enabled() || disposed) return false
    // Decided by this rule now: a queue entry an earlier session rule left goes (its claim with it, below).
    runs.unqueue(pluginId, it.id)
    const t = now()
    const limit = state.limitReason(rule, t)
    if (limit) {
      await releaseClaim(pluginId, it.id)
      await log({ at: t, ...base, step: 'limit', ...scored, ...also, skip: limit })
      return false
    }
    const runId = newRunId(randomBytes)
    let won
    try {
      won = await claims.claim({ source: pluginId, itemId: it.id, runId, rule: rule.ref })
    } catch (e) {
      await log({ at: t, ...base, step: 'claim', ...also, skip: `the app-wide claim failed: ${why(e)}; ${rule.act} not run` })
      return false
    }
    if (!won.ok) {
      const o = won.owner
      const who = o ? ` (${CLI.oneLine(o.project, 200)}, ${CLI.oneLine(o.rule, 80) || 'a rule'})` : ''
      await log({ at: t, ...base, step: 'claim', ...also, skip: `held by another window${who}: ${rule.act} not run here` })
      return false
    }
    let reply
    try {
      reply = await store.act(pluginId, it.id, rule.act)
    } finally {
      // Held only while the action runs: nothing of this item stays in flight afterwards.
      await releaseClaim(pluginId, it.id)
    }
    if (!reply.ok) {
      await log({ at: now(), ...base, step: 'act', ...scored, ...also, skip: `${rule.act} failed: ${CLI.oneLine(reply.message || 'the source refused it', 300)}` })
      return false
    }
    await state.markFired(rule.ref, pluginId, it.id, it.rev, t).catch(warn('state'))
    await state.recordOpen(rule.ref, t, 'act').catch(warn('state'))
    await log({ at: t, ...base, step: 'act', ...scored, ...also, outcome: actDone(rule.act, it) })
    return true
  }

  /**
   * Items whose decision waits for a Jev answer or a retry: key → `{ pluginId, id }`. Only these are
   * decided again when lib/jev.js hands refs back (`onJevAnswer`), with the item's latest copy from the
   * store; an item that left its feed meanwhile is dropped. In memory: after a restart the item is in
   * the baseline and never fires, as any item listed before the start.
   */
  const waiting = new Map()
  const keyOf = (pluginId, id) => `${pluginId}\u0000${id}`

  /** One item's decision (lib/match.js `evaluate`) and what follows from it. */
  async function decide(pluginId, it) {
    const key = keyOf(pluginId, it.id)
    // The item has a run (its tab, or one being opened): it never goes through the rules again while
    // the tab exists, and a later rule change does not move it to another rule (design-v2).
    const run = runs.runOf(pluginId, it.id)
    if (run) {
      waiting.delete(key)
      runs.unqueue(pluginId, it.id)
      await onRunUpdate(run, pluginId, it)
      return
    }
    const ev = evaluate(loaded.rules, pluginId, it, evalOpts(jev.answer, true))
    if (ev.decision === 'wait') {
      // Held: lower rules do not fire meanwhile. Not logged (the answer comes within 45 s, or a
      // retry is logged then).
      waiting.set(key, { pluginId, id: it.id })
      return
    }
    if (ev.decision === 'retry') {
      waiting.set(key, { pluginId, id: it.id })
      await log({ at: now(), ...itemOfEntry(ev.rule, { pluginId }, it), step: 'jev', skip: `${ev.reason}; asked again in 10 min, no lower rule fires meanwhile` })
      return
    }
    waiting.delete(key)
    // Anything but a fire takes a queued item out (it no longer holds, or is decided by a lower rule).
    if (ev.decision !== 'fire') await dequeue(pluginId, it.id)
    // An act rule above the deciding one whose action the item does not offer (design: "skip the rule,
    // log why, fall through"): its line, since the person asks "why did my rule not run".
    if (ev.decision === 'fire') {
      for (const tr of ev.trace) if (tr.step === 'action') await log({ at: now(), ...itemOfEntry(tr.rule, { pluginId }, it), step: 'action', skip: tr.skip })
    }
    if (ev.decision === 'none') {
      // What a person would ask about ("why did my rule not fire?"): a rule that matched on fields but
      // was outside its hours or under its Jev threshold. An off rule is not logged (the person turned it off).
      for (const tr of ev.trace) {
        // An update past an act rule is no news to the person (every chat reply would be a line).
        if (tr.step === 'off' || tr.step === 'update') continue
        await log({ at: now(), ...itemOfEntry(tr.rule, { pluginId }, it), step: tr.step, ...(tr.score !== undefined ? { score: tr.score } : {}), skip: tr.skip })
      }
      return
    }
    const rec = state.fired(ev.rule.ref, pluginId, it.id)
    // Once per item; with onChange once per rev. The item's rule decided, so a lower rule never
    // gets the item instead.
    if (rec && (!ev.rule.onChange || rec.rev === it.rev)) {
      await dequeue(pluginId, it.id)
      return
    }
    await tryRule(ev, pluginId, it)
  }

  const runEntry = (rule, pluginId, it) => ({ at: now(), rule, source: pluginId, itemId: it.id, title: text(it.title, 200) || '' })
  const revText = (rev) => CLI.oneLine(rev, 60)

  /**
   * A new rev (or a re-decision) of an item whose tab exists or is opening: design-v2's table "While
   * the item's tab exists". The item's rule is the one that opened the tab (by id, read now: a rule
   * switched off or no longer `onChange` delivers nothing more; a later rule never takes the item over).
   * - not `onChange` (or the rule is gone or off): logged, nothing sent;
   * - taken over, stopped, 5 delivered, or an app that cannot tell typing: logged, nothing sent;
   * - the person's own reply (`myNames`): logged "your reply", not delivered (an older pending stays);
   * - otherwise the item's pending update (replacing an older one), delivered by `deliver()`.
   */
  async function onRunUpdate(run, pluginId, it) {
    const rec = run.kind === 'tab' ? run.record : null
    const rev = rec ? rec.rev : run.rev
    if (rev === it.rev) return
    const ruleId = rec ? rec.rule : run.rule
    const pend = runs.pendingOf(pluginId, it.id)
    // Decided again with the same copy (a dequeue, a Jev answer): already pending, nothing new.
    if (pend && pend.item.rev === it.rev) return
    const where = rec ? `tab ${rec.tabId} open` : 'its tab is opening'
    const skip = (why) => log({ ...runEntry(ruleId, pluginId, it), step: 'update', skip: `updated (rev ${revText(it.rev)}), ${why}` })
    const rule = ruleByRef(ruleId)
    if (!rule || !rule.onChange) return skip(`${where}: nothing sent${rule ? '' : ` (rule ${ruleId} is gone)`}`)
    if (!rule.enabled) return skip(`${where}: nothing sent (rule ${ruleId} is off)`)
    // Updates go only from the window that holds the item's claim (a restored tab whose item another
    // window claimed meanwhile, a claim that ended with its tab, or one lost to a stale takeover).
    if (!claims.owns(pluginId, it.id)) return skip(`${where}: nothing sent (this window does not hold the item's claim)`)
    const blocked = rec && runs.blocked(rec)
    if (blocked) return skip(`${blocked}; nothing sent`)
    // An app before 0.11 cannot say whether the person typed: deliver nothing at all (Solution
    // Overview). 'unknown' (no tab listed yet: one just opening) waits, deliver() checks again.
    if (runs.support() === 'no') return skip(`${where}: nothing sent (this app does not report typing in a tab: updates need cc-cockpit 0.11)`)
    if (RUNS.isOwn(it, RUNS.myNamesOf(ctx.settings))) return skip(`your reply: not delivered`)
    const replaced = runs.setPending(pluginId, it.id, it)
    await log({ ...runEntry(ruleId, pluginId, it), step: 'update', note: `updated (rev ${revText(it.rev)}): pending for ${rec ? `tab ${rec.tabId}` : 'its tab (opening)'}, sent when Claude waits for input${replaced !== null ? `; replaces rev ${revText(replaced)}` : ''}` })
    await deliver()
  }

  /**
   * Deliver the pending updates whose tab is waiting for input now (design-v2 "The pending update").
   * Autopilot sends only when it sees the tab `waiting` with `typed === false`, so main's own queue (a
   * send to a busy tab is held there and dropped if the person types) is rarely used; main still
   * refuses a typed tab, which is the guard, since this view of the tab can be a moment old. A send is
   * one bracketed paste plus Enter (the send gate); a refused one is logged and the update dropped.
   * Runs inside the judging queue, so two calls never send the same update.
   */
  async function deliver() {
    for (const p of runs.pendings()) {
      if (disposed || !state.enabled()) return
      const run = runs.runOf(p.source, p.itemId)
      // Still opening: delivered once the tab is recorded and waits. No run at all: its tab closed.
      if (run && run.kind === 'opening') continue
      const it = p.item
      if (!run) {
        runs.dropPending(p.source, p.itemId)
        continue
      }
      const rec = run.record
      const drop = (why, ok = false) => {
        runs.dropPending(p.source, p.itemId)
        return log({ ...runEntry(rec.rule, p.source, it), step: 'update', ...(ok ? { note: why } : { skip: why }) })
      }
      const blocked = runs.blocked(rec)
      if (blocked) {
        await drop(`update rev ${revText(it.rev)} dropped: ${blocked}`)
        continue
      }
      if (!claims.owns(p.source, p.itemId)) {
        await drop(`update rev ${revText(it.rev)} dropped: this window no longer holds the item's claim`)
        continue
      }
      const support = runs.support()
      if (support === 'no') {
        await drop(`update rev ${revText(it.rev)} dropped: this app does not report typing in a tab (updates need cc-cockpit 0.11)`)
        continue
      }
      const tab = run.tab
      // Unknown support, the tab not listed yet, busy, or waiting for a permission answer (a keystroke
      // could answer it): keep it for a later onChange. `typed` strictly false: true is handled by
      // the run check (taken over), anything else is a tab that cannot tell.
      if (support !== 'yes' || !tab || tab.typed !== false || tab.status !== 'waiting') continue
      let body
      try {
        body = deliveryText(it, it.rev, rec.runId, { randomBytes, pluginId: p.source, mode: rec.mode })
      } catch (e) {
        await drop(`update rev ${revText(it.rev)} dropped: ${why(e)}`)
        continue
      }
      // Out of the pending set before the await: a new rev meanwhile is a new pending update.
      runs.dropPending(p.source, p.itemId)
      try {
        await ctx.sessions.send(rec.tabId, body)
      } catch (e) {
        // Main refused: the person typed a moment ago ("the person is typing in this tab"), the tab
        // closed, the window is going. Dropped, never retried: the next onChange tells what happened.
        await log({ ...runEntry(rec.rule, p.source, it), step: 'update', skip: `update rev ${revText(it.rev)} for tab ${rec.tabId}: send refused: ${why(e)}; dropped` })
        continue
      }
      await runs.delivered(p.source, p.itemId, it.rev).catch(warn('runs'))
      await log({ ...runEntry(rec.rule, p.source, it), step: 'update', note: `update rev ${revText(it.rev)} delivered into tab ${rec.tabId} (${rec.deliveries} of ${RUNS.DELIVERY_MAX})` })
    }
  }

  // ---- runs (lib/runs.js) ----

  /**
   * Check the runs against the window's Claude tabs (`list`, or a fresh ctx.sessions.list()), and log
   * what changed: a closed tab frees its item, a restored tab is re-adopted as taken over, a tab that
   * ended right after opening names its rule (a model or effort Claude Code refused shows this way).
   */
  async function syncRuns(list) {
    if (list === undefined) {
      try {
        list = await ctx.sessions.list()
      } catch (e) {
        ctx.log.warn(`sessions.list: ${why(e)}`)
        return
      }
    }
    const ch = await runs.reconcile(list).catch((e) => {
      ctx.log.warn(`runs: ${why(e)}`)
      return { dropped: [], adopted: [], endedEarly: [], takenOver: [] }
    })
    const entry = (r, note) => ({ at: now(), rule: r.rule, source: r.source, itemId: r.itemId, title: '', step: 'run', note })
    for (const r of ch.dropped) {
      // The tab is gone: so is the item's app-wide claim (any window may open it again).
      if (!runs.runOf(r.source, r.itemId) && !runs.isQueued(r.source, r.itemId)) await releaseClaim(r.source, r.itemId)
      await log(entry(r, `tab ${r.tabId} closed: the item is free`))
    }
    for (const r of ch.adopted) await log(entry(r, `restored tab ${r.tabId} re-adopted (same Claude session); taken over: nothing is delivered into it`))
    for (const r of ch.endedEarly) await log(entry(r, `tab ${r.tabId} ended within a minute of opening: check the rule's model and effort`))
    for (const r of ch.takenOver) await log(entry(r, `taken over: you typed in tab ${r.tabId}; nothing more is delivered into it${r.droppedRev !== null ? ` (pending update rev ${revText(r.droppedRev)} dropped)` : ''}`))
  }

  /**
   * Free slots and a queue: decide the queued items again, oldest first, each with its latest copy
   * from the store (it may be gone, read or changed by now) and from the top of the rules. Stops at
   * the cap; an item that fires at the cap again keeps its place.
   */
  async function drain() {
    for (const q of runs.queued()) {
      if (disposed || !state.enabled()) return
      if (runs.running() >= maxRunning()) return
      const src = store.get(q.source)
      const it = src && src.items.find((x) => x.id === q.itemId)
      if (!it) {
        await dequeue(q.source, q.itemId)
        await log({ at: now(), rule: '', source: q.source, itemId: q.itemId, title: '', step: 'cap', skip: 'left its feed while queued: not opened' })
        continue
      }
      await decide(q.source, it)
    }
  }

  /** The sessions changed (ctx.sessions.onChange): check the runs, open what the freed slots allow. */
  function onSessions(list) {
    if (disposed) return
    void enqueue(async () => {
      if (disposed) return
      await syncRuns(list)
      if (state.enabled() && runs.queued().length && runs.running() < maxRunning()) {
        await reloadRules()
        await drain()
      }
      // A tab that turned waiting (Claude done with its turn) takes its pending update now.
      await deliver()
      // A tab that ended releases its claim (settleClaims).
      await settleClaims()
      publish()
    }).catch(warn('sessions'))
  }

  /** Fresh items of one source against the rules, read fresh from the folder (design "v1 scope"). */
  async function judge(pluginId, fresh) {
    await reloadRules()
    // A stale record must never block an item (design-v2): the runs are checked before the decisions.
    await syncRuns()
    for (const it of fresh) {
      if (!state.enabled() || disposed) break
      await decide(pluginId, it)
    }
    if (!disposed) await settleClaims()
  }

  /**
   * lib/jev.js answered (or gave up on, or retries) these items: decide again those still waiting,
   * with their latest copy (a newer rev may have come meanwhile; the evaluation asks for that one).
   */
  function onJevAnswer(refs) {
    if (disposed || !state.enabled()) return
    const mine = refs.filter((r) => waiting.has(keyOf(r.pluginId, r.id)))
    if (!mine.length) return
    void enqueue(async () => {
      if (disposed || !state.enabled()) return
      await reloadRules()
      await syncRuns()
      for (const r of mine) {
        const key = keyOf(r.pluginId, r.id)
        if (!waiting.has(key)) continue
        const src = store.get(r.pluginId)
        const it = src && src.items.find((x) => x.id === r.id)
        if (!it) {
          waiting.delete(key)
          continue
        }
        await decide(r.pluginId, it)
      }
      publish()
    }).catch(warn('judge'))
  }

  const jev = createJev({ store: appStore, services: ctx.services, onAnswer: onJevAnswer, now, timers, log: ctx.log })
  let jevLoadedAt = -Infinity

  // ---- the dry run ----

  /**
   * The rule a `test` word names: a ref (`global:r1`), or an id that one level alone has. An id both
   * levels have is refused rather than guessed (the answer would be about the wrong rule). Resolves
   * `{ ref }` or `{ error }`; a rule with a problem says so (it is skipped, so it is not in `rules`).
   */
  function resolveRule(rules, sel) {
    const q = CLI.oneLine(sel, 80)
    if (sel.includes(':')) {
      if (rules.some((r) => r.ref === sel)) return { ref: sel }
      const [level, id] = [sel.slice(0, sel.indexOf(':')), sel.slice(sel.indexOf(':') + 1)]
      const bad = S.LEVELS.includes(level) && loaded.problems.some((p) => p.startsWith(`${level}:`) && p.includes(`"${id}"`))
      return { error: bad ? `Rule ${q} has a problem and is skipped (ccc autopilot reload shows it).` : `No rule ${q}: ${foldersText()}.` }
    }
    const hits = rules.filter((r) => r.id === sel)
    if (hits.length === 1) return { ref: hits[0].ref }
    if (hits.length > 1) return { error: `Both levels have a rule ${q}: name it ${hits.map((r) => r.ref).join(' or ')} (or add --project / --global).` }
    const bad = loaded.problems.some((p) => p.includes(`"${sel}"`))
    return { error: bad ? `Rule "${q}" has a problem and is skipped (ccc autopilot reload shows it).` : `No rule "${q}": ${foldersText()}.` }
  }

  /** Where the rules are read from, for an answer: "project rules in X, global rules in Y". */
  function foldersText() {
    const parts = S.LEVELS.map((l) => {
      const lv = levelOf(l)
      return lv ? `${l} rules in ${R.displayPath(lv.folder, home)}/${R.RULES_FILE}` : `no ${l} rules folder`
    })
    return parts.join(', ')
  }

  /**
   * What the current items would do, decided as the live path decides (lib/match.js `evaluate`: first
   * rule wins), with no session and, unless `withJev`, no Jev request (cached answers still count).
   * One row per rule that matched on fields: the item's rule with its verdict (already fired, limits,
   * would open), the rules that also matched (never run), and those that did not hold (off, outside
   * hours, under the Jev threshold). `ruleSel` (a ref `project:r1`, or an id that only one level has)
   * keeps that rule's rows only, still decided over every rule of both levels (a higher rule taking the
   * item first is the answer to "why does mine not fire"); `levelOnly` keeps one level's rows. With
   * `withJev`, the answers are asked through lib/jev.js (so they land in the cache), at most
   * DRY_JEV_MAX, then the items decided again. Resolves `{ error }` for an unknown or ambiguous rule.
   * `candidate` (`ccc autopilot test <json>`): a rule that is not stored, `{ rule, warnings, at, level }`
   * with `rule` already checked. It is decided as on, in the place of the stored rule of its id in its
   * level or else at `at` (a position in that level's rules file; null: the end of that level), and only
   * its rows are kept, so the answer to "would my edit fire" needs no write and no switch-on.
   */
  async function dryRun(ruleSel, withJev, candidate = null, levelOnly = null) {
    await reloadRules()
    let all = loaded.rules
    let cand = null
    let ruleRef = null
    if (candidate) {
      const ref = S.refOf(candidate.level, candidate.rule.id)
      const was = all.findIndex((r) => r.ref === ref)
      const rule = { ...candidate.rule, level: candidate.level, ref, enabled: true, warnings: candidate.warnings }
      // `at` counts entries of the level's file, the invalid ones too; the rules in play are the valid
      // ones, and the candidate stays inside its level (project rules all come before global ones).
      const lv = levelOf(candidate.level)
      const mine = all.filter((r) => r.level === candidate.level).length
      const within = candidate.at === null || !lv ? mine : lv.entries.slice(0, candidate.at - 1).filter((e) => e.rule).length
      const first = all.findIndex((r) => r.level === candidate.level)
      const start = first >= 0 ? first : candidate.level === S.LEVELS[0] ? 0 : all.length
      all = was >= 0 ? all.map((r, i) => (i === was ? rule : r)) : [...all.slice(0, start + within), rule, ...all.slice(start + within)]
      ruleRef = ref
      cand = { id: ref, replaced: was >= 0, at: within + 1, warnings: candidate.warnings }
    } else if (ruleSel) {
      const r = resolveRule(all, ruleSel)
      if (r.error) return r
      ruleRef = r.ref
    }
    const list = sourceList()
    const pairs = list.flatMap((s) => s.items.map((it) => ({ pluginId: s.pluginId, it })))
    // Asking: each pass decides every item with cached answers; a pending one is asked (up to the
    // cap) and the pass repeats, since an answer under `min` lets the next rule's question come up.
    const askedKeys = new Set()
    const failed = new Map()
    let asked = 0
    const dryAnswer = (rule, pluginId, it) => {
      const c = jev.cached(rule, pluginId, it)
      if (c) return c
      const k = `${rule.jev.question}\u0000${keyOf(pluginId, it.id)}`
      if (failed.has(k)) return { unavailable: failed.get(k) }
      if (withJev && !jev.available()) return { unavailable: 'jev unavailable: no enabled plugin provides the jev service' }
      return { pending: true }
    }
    for (let round = 0; withJev && round < DRY_JEV_MAX && asked < DRY_JEV_MAX && jev.available(); round++) {
      const asks = []
      for (const { pluginId, it } of pairs) {
        const ev = evaluate(all, pluginId, it, evalOpts(dryAnswer))
        if (ev.decision !== 'wait' || asked >= DRY_JEV_MAX) continue
        const k = `${ev.rule.jev.question}\u0000${keyOf(pluginId, it.id)}`
        if (askedKeys.has(k)) continue
        askedKeys.add(k)
        asked++
        asks.push(jev.ask(ev.rule, pluginId, it).then((a) => {
          if (!a || typeof a.score !== 'number') failed.set(k, (a && a.unavailable) || 'jev unavailable')
        }))
      }
      if (!asks.length) break
      let timer
      const late = new Promise((r) => { timer = timers.setTimeout(r, opts.dryJevMs ?? DRY_JEV_MS) })
      await Promise.race([Promise.all(asks), late])
      timers.clearTimeout(timer)
    }
    const t = now()
    const results = []
    let cut = 0
    const add = (row) => {
      if (ruleRef && row.rule !== ruleRef) return
      if (levelOnly && !row.rule.startsWith(`${levelOnly}:`)) return
      if (results.length >= DRY_MAX) return void cut++
      results.push(row)
    }
    for (const { pluginId, it } of pairs) {
      const ev = evaluate(all, pluginId, it, evalOpts(dryAnswer))
      const row = (rule, why, fire, verdict, score) => ({ rule: rule.ref, source: pluginId, itemId: it.id, title: it.title, why, fire, verdict, ...(score !== undefined ? { score } : {}) })
      for (const tr of ev.trace) {
        const verdict = tr.step === 'hours' ? `outside its hours ${S.hoursLabel(tr.rule.hours)} right now (local time): it would not fire` : tr.skip
        add(row(tr.rule, tr.why, false, verdict, tr.score))
      }
      /**
       * The rules below the deciding one that match on sources and fields: not "also matched" (that
       * needs a cached yes for a Jev rule, and the rule on and in its hours), but the answer to "why
       * does my rule not fire" when testing one rule. Free: no request. `each(rule, why)` is called in
       * file order for the rules on and in their hours; the off and out-of-hours ones are rows here.
       */
      const below = (each) => {
        for (const r of all.slice(all.indexOf(ev.rule) + 1)) {
          const m = matchRule(r, pluginId, it, { kindOf, now: t })
          if (!m) continue
          if (!r.enabled) add(row(r, m.why, false, 'the rule is off'))
          else if (!S.inHours(r.hours, t)) add(row(r, m.why, false, `outside its hours ${S.hoursLabel(r.hours)} right now (local time): it would not fire`))
          else each(r, m.why)
        }
      }
      if (ev.decision === 'wait') {
        const verdict = !withJev ? `the Jev step was not asked (would need ≥ ${ev.rule.jev.min}; add --jev)` : `Jev not asked or not answered: at most ${DRY_JEV_MAX} questions per dry run`
        add(row(ev.rule, ev.why, null, `${verdict}; no lower rule fires until it answers`))
        below((r, w) => add(row(r, w, null, `waits for the Jev answer of ${ev.rule.ref}, which comes first`)))
      } else if (ev.decision === 'retry') {
        add(row(ev.rule, ev.why, false, `${ev.reason}; no lower rule fires (asked again in 10 min)`))
        below((r, w) => add(row(r, w, false, `${ev.rule.ref} comes first and its Jev is unavailable`)))
      } else if (ev.decision === 'fire') {
        const r = ev.rule
        const rec = state.fired(r.ref, pluginId, it.id)
        const jv = ev.score !== undefined ? `jev ${ev.score.toFixed(2)}, ` : ''
        // The item's tab exists (lib/runs.js): the live path never opens a second one.
        const run = runs.runOf(pluginId, it.id)
        // An act rule (lib/match.js checked its action is offered): it would run that, with no session.
        const would = r.act ? `would run ${r.act} on the item (no session)` : 'it would open a session'
        if (run) add(row(r, ev.why, false, run.kind === 'tab' ? `its tab ${run.record.tabId} is open (rule ${run.record.rule}): no second session` : 'its tab is opening: no second session', ev.score))
        else if (rec && (!r.onChange || rec.rev === it.rev)) add(row(r, ev.why, false, `already fired on this item (${CLI.when(rec.at)})`, ev.score))
        else {
          const limit = state.limitReason(r, t)
          add(row(r, ev.why, !limit, limit ? `limit: ${limit}` : `${jv}${would}`, ev.score))
        }
        // In file order: the also-matched ones with their score; what is left is a Jev rule with no
        // cached yes (no answer yet, or one under its `min`).
        below((b, w) => {
          const a = ev.also.find((x) => x.rule === b)
          const c = a ? null : jev.cached(b, pluginId, it)
          if (a) add(row(b, w, false, `also matched: ${r.ref} comes first and takes the item`, a.score))
          else if (c) add(row(b, w, false, `jev ${c.score.toFixed(2)} is below ${b.jev.min}`, c.score))
          else add(row(b, w, false, `${r.ref} comes first and takes the item (the Jev step of this rule was not asked)`))
        })
      }
    }
    lastDry = { at: t, on: state.enabled(), jev: Boolean(withJev), rules: ruleRef ? 1 : levelOnly ? all.filter((r) => r.level === levelOnly).length : all.length, sources: list.length, items: pairs.length, results, cut, ...(cand ? { candidate: cand } : {}) }
    return lastDry
  }

  // ---- the switch ----

  /** Switch on or off. On re-takes every source's baseline first, so nothing already listed fires. */
  async function setEnabled(on) {
    const was = state.enabled()
    if (on) {
      // A refresh already running read before this: let it finish, then take a new baseline (a
      // read that lands between the flag and the switch is a baseline too).
      if (ticking) await ticking.catch(() => {})
      store.rebaseline()
      await state.setEnabled(true)
      await tick()
      const n = sourceList().reduce((a, s) => a + s.items.length, 0)
      if (!was) await log({ at: now(), step: 'switch', note: `Autopilot switched on; baseline: ${n} item${n === 1 ? '' : 's'} in the feeds, only new or changed ones fire` })
      publish()
      return n
    }
    await state.setEnabled(false)
    // Off: nothing waits for a decision any more (switching on again takes a new baseline).
    waiting.clear()
    runs.clearQueue()
    // The queue's claims go with it (the tabs keep theirs: they still work on their items).
    await enqueue(() => settleClaims()).catch(warn('claims'))
    // Nothing is sent while off; the next news after switching on makes a new pending update.
    runs.clearPending()
    if (was) await log({ at: now(), step: 'switch', note: 'Autopilot switched off' })
    publish()
    return 0
  }

  // ---- the panel ----

  /**
   * One level for the panel's editor and the CLI: its folder (as the person sees it; null when the
   * level has no folder), the folder's state, the hash a write must name, every entry of its rules file
   * (valid or not, with its raw value to fill the form), its playbook files and the v1 hint.
   */
  function levelStatus(level) {
    const lv = levelOf(level)
    const base = { level, label: S.LEVEL_LABELS[level], setting: level === 'global' ? 'globalFolder' : 'projectFolder' }
    if (!lv) return { ...base, folder: null, folderPath: null, folderState: 'off', editable: false, rulesHash: null, entries: [], playbookFiles: [], hint: null, base: null, baseProblem: null }
    return {
      ...base,
      folder: R.displayPath(lv.folder, home),
      folderPath: lv.folder,
      folderState: lv.folderState,
      // A level with a folder is writable before its file exists (the first save makes folder and file);
      // only a file that exists and is not a JSON list (or cannot be read) is left alone.
      editable: Array.isArray(lv.raw) || lv.folderState === 'missing' || lv.folderState === 'noRules',
      rulesHash: lv.hash,
      entries: lv.entries.map((e) => ({
        level,
        index: e.index,
        id: e.id,
        ref: e.id !== null ? S.refOf(level, e.id) : null,
        raw: e.raw,
        ok: Boolean(e.rule),
        schema: e.schema,
        on: e.rule ? e.rule.enabled : !(e.raw && e.raw.enabled === false),
        summary: e.rule ? R.summaryOf(e.rule) : '',
        warnings: e.rule ? warningsOf(e.rule) : e.warnings,
        problem: e.problem,
      })),
      playbookFiles: lv.playbookFiles || [],
      hint: lv.hint,
      // The level's base.md (design-v2 "base.md"): in use (its size), or a problem; the text itself is
      // read only when the panel opens it (openBase), so the state message stays small.
      base: lv.base ? { size: lv.base.size } : null,
      baseProblem: lv.baseProblem || null,
    }
  }

  function status() {
    return {
      on: state.enabled(),
      problems: [...loaded.problems],
      // Plain notes, never problems (no badge): a v1 rules.json that is not read.
      hints: loaded.hints.map((h) => `${S.LEVEL_LABELS[h.level]} folder: ${h.text}`),
      rules: loaded.rules.map((r) => ({ ref: r.ref, level: r.level, id: r.id, on: r.enabled, summary: R.summaryOf(r), warnings: warningsOf(r), triage: r.jev ? 'jev' : 'none', playbook: r.playbook, act: r.act, mode: r.mode })),
      levels: S.LEVELS.map(levelStatus),
      jev: ctx.services.available(JEV),
      sources: sourceList().map((s) => ({ pluginId: s.pluginId, label: s.desc.label, kind: s.desc.kind, items: s.items.length, ...(s.error ? { error: s.error } : {}) })),
      log: state.recent(),
      // The runs (plan Task 13 shows them): each item's tab and its status now, the queue, the cap,
      // and whether this app reports typing ('unknown' until a Claude tab exists).
      running: runs.list().map((r) => ({ rule: r.rule, source: r.source, itemId: r.itemId, tabId: r.tabId, status: r.status, openedAt: r.openedAt, runId: r.runId, takenOver: r.takenOver, stopped: r.stopped, deliveries: r.deliveries, pending: r.pending })),
      queued: runs.queued().map((q) => ({ source: q.source, itemId: q.itemId, at: q.at })),
      maxRunning: maxRunning(),
      slots: runs.running(),
      takeover: runs.support(),
    }
  }

  let lastHeader = ''
  function header() {
    if (typeof ctx.panels.header !== 'function') return
    const on = state.enabled()
    // The tab's basis: every entry of the rules files, valid or not; `on` counts the valid enabled rules.
    const n = loaded.rules.filter((r) => r.enabled).length
    const total = ['project', 'global'].reduce((a, k) => a + (loaded.levels[k] ? loaded.levels[k].entries.length : 0), 0)
    const p = loaded.problems.length
    const spec = {
      meta: `${on ? 'on' : 'off'} · ${n >= total ? `${n} rule${n === 1 ? '' : 's'}` : `${n} of ${total} rule${total === 1 ? '' : 's'} on`}${p ? ` · ${p} problem${p === 1 ? '' : 's'}` : ''}`,
      actions: [{ id: 'refresh', icon: 'refresh', title: 'Read the rules folder and every feed again' }],
    }
    const json = JSON.stringify(spec)
    if (json === lastHeader) return
    lastHeader = json
    try {
      ctx.panels.header(PANEL, spec)
    } catch (e) {
      ctx.log.warn(`panel header: ${why(e)}`)
    }
  }

  function publish() {
    if (disposed) return
    header()
    try {
      ctx.panels.post(PANEL, { type: 'state', now: now(), ...status(), dry: lastDry })
    } catch (e) {
      ctx.log.error(`post: ${why(e)}`)
    }
    try {
      ctx.badge(PANEL, loaded.problems.length ? 'dot' : null)
    } catch {
      // a badge is a nicety
    }
  }

  // ---- rule and playbook management (lib/manage.js) ----

  let writing = Promise.resolve()
  /** One write at a time: two edits from the panel never interleave their read-check-write. */
  function serial(fn) {
    const job = writing.then(fn)
    writing = job.catch(() => {})
    return job
  }

  const reply = (m) => {
    try {
      ctx.panels.post(PANEL, { type: 'result', ...m })
    } catch (e) {
      ctx.log.warn(`post: ${why(e)}`)
    }
  }

  /**
   * The folder of the level an edit names (`m.level`: project or global), from the settings now: the
   * panel's or the CLI's idea of it can be a moment old. Throws the refusal the panel shows.
   */
  function editFolder(level) {
    if (!S.LEVELS.includes(level)) throw new M.ManageError('say which rules: project or global')
    const folder = folderOf(level)
    if (!folder) throw new M.ManageError(level === 'global' ? 'there is no global rules folder: set the app setting "Global rules folder"' : 'this project has no project rules folder: set the project setting "Project rules folder"')
    return folder
  }

  /**
   * An edit of one level's rules file: refused unless the panel's `hash` is the one the host last read
   * of THAT file AND the file on disk still has it (a hand edit since is never overwritten), and unless
   * the file is a JSON list. `mutate(raw)` is a manage.js apply* (pure); its list is written whole.
   * The other level's file is never read or written by an edit of this one.
   */
  async function editRules(m, mutate) {
    const folder = editFolder(m.level)
    const lv = levelOf(m.level)
    const cur = await M.readRulesFile(fs, folder)
    if (!lv || lv.folder !== folder || m.hash !== lv.hash || cur.hash !== lv.hash) throw new M.ManageError(M.STALE, { stale: true })
    // No file yet: the expected state is "absent" (hash null on both sides, checked above), so a file that
    // appeared since the load is the conflict above. The first save makes the folder and the file.
    if (!cur.exists) {
      const next = mutate([])
      await fs.mkdir(folder, { recursive: true })
      await M.writeRulesFile(fs, folder, next, randomBytes, { create: true })
      return
    }
    if (!cur.list) throw new M.ManageError(`${R.RULES_FILE} is not a JSON list of rules: fix it by hand first (the panel never rewrites a file it cannot read)`)
    await M.writeRulesFile(fs, folder, mutate(cur.raw), randomBytes)
  }

  /**
   * Run one panel edit: serialized, then the folder read again and the state published, then the
   * `result` for the request. A refusal is the result's `error` (with `stale`, `fieldErrors`,
   * `hash`); a stale one re-reads and publishes first, so the panel has the fresh state when it
   * reads the result.
   */
  async function manage(m, fn) {
    const req = typeof m.req === 'number' && Number.isFinite(m.req) ? m.req : null
    let out
    try {
      out = await serial(fn)
    } catch (e) {
      const known = e instanceof M.ManageError
      if (!known) ctx.log.warn(`${m.type}: ${why(e)}`)
      await reloadRules()
      publish()
      reply({ req, op: m.type, ok: false, error: known ? e.message : `That failed: ${why(e)}`, ...(known && e.stale ? { stale: true } : {}), ...(known && e.fieldErrors ? { fieldErrors: e.fieldErrors } : {}), ...(known && e.hash !== undefined ? { hash: e.hash } : {}), ...(known && e.usedBy ? { usedBy: e.usedBy } : {}) })
      return
    }
    await reloadRules()
    publish()
    reply({ req, op: m.type, ok: true, ...(out || {}) })
  }

  // Which entry the panel means: its index (null: a new rule) and the id it showed there.
  const ruleRef = (m) => ({ index: m.index ?? null, id: typeof m.id === 'string' ? m.id : null })

  const manageActs = {
    toggleRule: (m) => editRules(m, (raw) => M.applyToggle(raw, { ...ruleRef(m), on: m.on })),
    deleteRule: (m) => editRules(m, (raw) => M.applyDelete(raw, ruleRef(m))),
    async saveRule(m) {
      const ref = ruleRef(m)
      let stub = null
      await editRules(m, (raw) => {
        const next = M.applySave(raw, { ...ref, rule: m.rule })
        if (m.newPlaybook === true && typeof m.rule.playbook === 'string') stub = m.rule.playbook
        return next
      })
      // "New playbook…" in the form: the file gets a first text when there is none (the panel opens
      // it in the editor next). Written after the rule, so a refused rule makes no file; in the rule's
      // own level, where its playbook resolves.
      if (stub) {
        const folder = editFolder(m.level)
        const exists = await fs.lstat(M.playbookPath(folder, stub)).then(() => true, () => false)
        if (!exists) await M.writePlaybook(fs, folder, { name: stub, body: M.playbookStub(stub, m.rule.mode), create: true }, randomBytes)
      }
      return { id: m.rule.id, level: m.level, ...(stub ? { playbook: stub } : {}) }
    },
    async openPlaybook(m) {
      return { ...(await M.readPlaybook(fs, editFolder(m.level), m.name)), level: m.level }
    },
    async savePlaybook(m) {
      const hash = await M.writePlaybook(fs, editFolder(m.level), { name: m.name, body: m.body, create: m.create === true, hash: m.hash }, randomBytes)
      return { name: m.name, level: m.level, hash }
    },
    async deletePlaybook(m) {
      const folder = editFolder(m.level)
      // Who uses it is read from the level's file now, not from what the panel saw. Only that level's
      // rules can name it: a playbook resolves in its rule's own level.
      const cur = await M.readRulesFile(fs, folder)
      if (cur.exists && !cur.list) throw new M.ManageError(`${R.RULES_FILE} is not a JSON list of rules, so which rules use ${m.name} cannot be told: fix it first`)
      await M.deletePlaybook(fs, folder, m.name, cur.raw)
      return { name: m.name, level: m.level }
    },
    // The level's base.md, edited like a playbook: read with its hash, written only over the file the
    // editor was shown (a hand edit since is "changed on disk"); an empty text removes the file.
    async openBase(m) {
      return { ...(await M.readBase(fs, editFolder(m.level))), level: m.level }
    },
    async saveBase(m) {
      const hash = await M.writeBase(fs, editFolder(m.level), { body: m.body, hash: m.hash === undefined ? null : m.hash }, randomBytes)
      return { level: m.level, hash, removed: hash === null }
    },
    async createFolder(m) {
      const folder = editFolder(m.level)
      await M.createFolder(fs, folder, randomBytes)
      return { folder: R.displayPath(folder, home), level: m.level }
    },
    async addExamples(m) {
      return { ...(await M.addExamples(fs, editFolder(m.level), examplesDir, randomBytes)), level: m.level }
    },
    async askClaude() {
      const folders = Object.fromEntries(S.LEVELS.map((l) => [l, folderOf(l)]))
      const r = await ctx.sessions.open({ cwd: ctx.projectDir, prompt: F.askPrompt(folders), focus: true })
      return { tabId: r && typeof r.tabId === 'string' ? r.tabId : null }
    },
  }

  // ---- refresh ----

  /**
   * The full refresh: the folder, the provider set (the store joins new providers with a snapshot),
   * upkeep. Sources push `item` / `gone` / `sync` themselves, so the 60 s pass re-reads only a source
   * whose last snapshot failed or never came; `all` (the panel's refresh) asks every source again,
   * which is a later read and so finds news like any sync.
   */
  /**
   * `scheduled`: the 60 s schedule's pass (only those count for the claims' refresh, sweep and
   * stale watch: a refresh button pressed ten times is not ten minutes of watching).
   */
  async function tick(all = false, scheduled = false) {
    if (ticking) return ticking
    ticking = (async () => {
      await reloadRules()
      await store.start()
      await Promise.all(store.list().filter((r) => all || !r.loaded || r.error).map((r) => store.snapshot(r.pluginId)))
      // Wait for the judging the reads queued, so a caller (the switch, the CLI) sees its result.
      await queue
      // The runs once a pass too: a record whose tab never showed is dropped after its grace even when
      // no onChange comes, and a slot that freed with no event opens what is queued.
      await enqueue(async () => {
        await syncRuns()
        if (state.enabled() && !disposed) await drain()
        await deliver()
        if (disposed) return
        await settleClaims()
        if (scheduled) await claimsPass()
      }).catch(warn('runs'))
      if (disposed) return
      // Other windows' cached Jev answers, every 10 minutes (each answer is its own key).
      if (now() - jevLoadedAt >= JEV_LOAD_MS) {
        jevLoadedAt = now()
        await jev.load().catch(warn('jev cache'))
      }
      await state.prune(now()).catch(warn('prune'))
      await jev.prune().catch(warn('jev prune'))
      publish()
    })().finally(() => {
      ticking = null
    })
    return ticking
  }

  async function act(m) {
    // The stored switch is loaded by the first refresh; a toggle before it would be overwritten.
    await first
    switch (m.type) {
      case 'hello':
      case 'visible':
        publish()
        return
      case 'refresh':
        await tick(true)
        return
      case 'toggle':
        if (typeof m.on === 'boolean') await setEnabled(m.on)
        return
      case 'dryRun':
        await dryRun(null, m.jev === true)
        publish()
        return
      case 'clearDry':
        lastDry = null
        publish()
        return
      default:
        if (Object.hasOwn(manageActs, m.type)) await manage(m, () => manageActs[m.type](m))
    }
  }

  async function onPanelMessage(m) {
    if (typeof m !== 'object' || m === null || typeof m.type !== 'string') return
    try {
      await act(m)
    } catch (e) {
      ctx.log.warn(`${m.type}: ${why(e)}`)
      try {
        ctx.panels.post(PANEL, { type: 'notice', text: `That failed: ${why(e)}` })
      } catch {
        // the panel went away
      }
    }
  }

  disposers.push(ctx.panels.onMessage(PANEL, onPanelMessage))
  if (typeof ctx.panels.onAction === 'function') {
    disposers.push(ctx.panels.onAction(PANEL, (id) => {
      if (id === 'refresh') void tick(true).catch(warn('refresh'))
    }))
  }
  if (typeof ctx.onSettingsChange === 'function') disposers.push(ctx.onSettingsChange(() => void reloadRules().then(publish, warn('settings'))))
  disposers.push(ctx.schedule(REFRESH_S, () => tick(false, true)))
  if (typeof ctx.sessions.onChange === 'function') disposers.push(ctx.sessions.onChange((list) => onSessions(list)))
  // The stored switch first: the first reads are baselines either way, but the panel shows it.
  const first = Promise.all([state.load().catch(warn('state')), runs.load().catch(warn('runs'))])
    .then(() => enqueue(adoptClaims).catch(warn('claims')))
    .then(() => tick())
    .catch((e) => ctx.log.error(`first refresh: ${why(e)}`))

  // ---- `ccc autopilot` (lib/cli.js) ----

  // ---- `ccc autopilot rules` and `playbooks` (lib/cli.js): the panel's edits, from a Claude tab ----

  const nothingStored = (e) => {
    const lines = [`Nothing stored: ${CLI.oneLine(e.message, 400)}`]
    // The panel gets the per-field messages; a tab gets them all at once, so one retry fixes a rule.
    if (e.fieldErrors) for (const [f, m] of Object.entries(e.fieldErrors)) if (!e.message.includes(m)) lines.push(`  ${CLI.oneLine(f || 'rule', 40)}: ${CLI.oneLine(m, 300)}`)
    return { stderr: `${lines.join('\n')}\n`, code: 1 }
  }

  /**
   * The level a CLI write goes to (design-v2 "Two rule levels"): the one named (`--project`,
   * `--global`, or a `level:id` selector), else the one level whose folder exists. With both folders
   * there the level must be named: a rule written to the wrong file runs in the wrong projects, and
   * guessing would be that mistake made quietly. `{ level }` or `{ error }` (a usage error, exit 2).
   */
  function writeLevel(named) {
    const how = 'add --project (this project only) or --global (every project)'
    if (named) {
      if (!folderOf(named)) return { error: named === 'global' ? 'There is no global rules folder: the app setting "Global rules folder" is empty.' : 'This project has no project rules folder: set the project setting "Project rules folder" first.' }
      return { level: named }
    }
    const set = S.LEVELS.filter((l) => levelOf(l))
    const there = set.filter((l) => levelOf(l).folderState !== 'missing')
    if (there.length === 1) return { level: there[0] }
    if (there.length > 1) return { error: `Both rule levels have a folder: ${how}.` }
    // No folder exists yet: the one level that is set up (the write then says to create its folder).
    if (set.length === 1) return { level: set[0] }
    if (set.length > 1) return { error: `Neither rules folder exists yet: ${how}.` }
    return { error: 'No rules folder: set the app setting "Global rules folder" or the project setting "Project rules folder".' }
  }

  /**
   * A rule from JSON checked the way a save checks it, with its playbook in `level`'s folder: `{ rule,
   * warnings }` or `{ error }`. The playbook must exist already (the panel makes a stub; a tab writes
   * the playbook first with `playbooks set`, so a rule is never saved that cannot run). The checks of
   * `applySave` run again at the write, with the file as it is then.
   */
  async function checkedRule(raw, level) {
    const c = S.checkRule(raw)
    if (!c.rule) {
      const first = c.errors[0] ? c.errors[0].message : 'the rule is not valid'
      return { error: `Nothing stored: the rule is not valid: ${CLI.oneLine(first, 300)}${c.errors.slice(1).map((e) => `\n  ${CLI.oneLine(e.message, 300)}`).join('')}` }
    }
    const folder = folderOf(level)
    if (!folder) return { error: `Nothing stored: there is no ${level} rules folder` }
    // An act rule names no playbook: nothing to find.
    if (c.rule.act) return { rule: c.rule, warnings: c.warnings }
    const exists = await fs.stat(M.playbookPath(folder, c.rule.playbook)).then((st) => st.isFile(), () => false)
    if (!exists) return { error: `Nothing stored: playbook ${CLI.oneLine(c.rule.playbook, 64)} not found in ${R.displayPath(folder, home)}/${R.PLAYBOOKS_DIR} (the ${level} folder, where this rule's playbook resolves): write it first (ccc autopilot playbooks set --${level} ${CLI.oneLine(c.rule.playbook, 64)} -)` }
    // Act mode needs the playbook's "Allowed actions" list (rules.js would make the stored rule a
    // problem that never runs): refused here, so a tab learns it before anything is written.
    if (c.rule.mode === 'act') {
      const pb = await M.readPlaybook(fs, folder, c.rule.playbook).catch(() => null)
      if (!pb || !S.hasAllowedActions(R.parsePlaybook(pb.body).body)) return { error: `Nothing stored: mode "act" needs an "${S.ALLOWED_ACTIONS}" section in ${R.PLAYBOOKS_DIR}/${CLI.oneLine(c.rule.playbook, 64)}.md: a heading "## ${S.ALLOWED_ACTIONS}" with each action the session may take as a list item (ccc autopilot playbooks set --${level} ${CLI.oneLine(c.rule.playbook, 64)} -)` }
    }
    return { rule: c.rule, warnings: c.warnings }
  }

  /** The first id `r1`, `r2`, ... that no entry of the level's rules file uses (a rule given with no id). */
  function mintRuleId(level) {
    const lv = levelOf(level)
    const used = new Set(lv ? lv.entries.map((e) => e.id) : [])
    for (let n = 1; ; n++) if (!used.has(`r${n}`)) return `r${n}`
  }

  /** What a rule is after an edit, for the answer: its level, place, state and anything that stops it running. */
  function ruleAfter(level, id) {
    const lv = levelOf(level)
    const e = lv && lv.entries.find((x) => x.id === id)
    if (!e) return ''
    const name = `Rule ${S.refOf(level, CLI.oneLine(id, 64))} (${level} rule ${e.index + 1})`
    const w = (e.rule ? warningsOf(e.rule) : e.warnings).map((x) => `\n  ⚠ ${CLI.oneLine(x, 300)}`).join('')
    return e.rule ? `${name} is ${e.rule.enabled ? 'on' : 'off'}: ${CLI.oneLine(R.summaryOf(e.rule), 300)}${w}\n` : `${name} does not run: ${CLI.oneLine(e.problem || 'not valid', 300)}${w}\n`
  }

  async function cliRules(p, stdin) {
    if (p.sub === 'list') {
      await reloadRules()
      if (p.level && !levelOf(p.level)) return { stderr: `There is no ${p.level} rules folder.\n`, code: 1 }
      return { stdout: CLI.formatRules(status(), p.level || null) }
    }
    if (p.sub === 'export') {
      await reloadRules()
      // One level: its file as it is. Both: an object by level (null for a level with no readable
      // file), so a read never mixes the two files into one list that matches neither.
      if (p.level) {
        const lv = levelOf(p.level)
        if (!lv || !Array.isArray(lv.raw)) return { stderr: `The ${p.level} ${R.RULES_FILE} is not a readable JSON list of rules: ${lv ? lv.problems.map((x) => CLI.oneLine(x, 300)).join('; ') || 'not found' : 'no such folder'}\n`, code: 1 }
        return { stdout: M.rulesText(lv.raw) }
      }
      const both = Object.fromEntries(S.LEVELS.map((l) => [l, levelOf(l) && Array.isArray(levelOf(l).raw) ? levelOf(l).raw : null]))
      // Neither file readable: a failure, as for one level, so a script never takes `null`s for "no rules".
      if (S.LEVELS.every((l) => both[l] === null)) return { stderr: `No readable ${R.RULES_FILE}: ${foldersText()}\n`, code: 1 }
      return { stdout: `${JSON.stringify(both, null, 2)}\n` }
    }
    let rule = null
    if (p.input) {
      const j = CLI.jsonInput(p.input, stdin)
      if (j.error) return { stderr: `${j.error}\n`, code: 2 }
      rule = j.value
    }
    try {
      // One write at a time with the panel's: re-read the folders inside the turn, so the edit is made
      // on the file as it is now, and `editRules` refuses when it changes again before the rename.
      return await serial(async () => {
        await reloadRules()
        const w = writeLevel(p.level)
        if (w.error) return { stderr: `${w.error}\n`, code: 2 }
        const level = w.level
        const lv = levelOf(level)
        const hash = { level, hash: lv ? lv.hash : null }
        const list = lv && Array.isArray(lv.raw) ? lv.raw : null
        let id = null
        let note = ''
        let ignored = []
        if (p.sub === 'add' || p.sub === 'set') {
          // Added off unless the JSON says otherwise: a rule a tab writes starts nothing until the
          // person (or the tab, told to) enables it after a dry run. The file format's default stays on.
          const given = p.sub === 'add' ? { ...rule, ...(Object.hasOwn(rule, 'id') ? {} : { id: mintRuleId(level) }), ...(Object.hasOwn(rule, 'enabled') ? {} : { enabled: false }) } : rule
          // The rule as it will be written (a set keeps the id and on/off), for the playbook check
          // before any write; a file that is not a list is refused by editRules with its own words.
          const final = p.sub === 'set' && list ? M.setTarget(list, { sel: p.sel, rule }).rule : given
          const c = await checkedRule(final, level)
          if (c.error) return { stderr: `${c.error}\n`, code: 1 }
          id = c.rule.id
          ignored = c.warnings
          await editRules(hash, (raw) => (p.sub === 'add' ? M.applyAdd(raw, { rule: given, at: p.at }) : M.applySet(raw, { sel: p.sel, rule })))
          note = p.sub === 'add' ? `Added to the ${level} rules. ` : `Replaced in the ${level} rules. `
        } else if (p.sub === 'rm') {
          await editRules(hash, (raw) => M.applyDelete(raw, M.locateEntry(raw, p.sel)))
          await reloadRules()
          publish()
          return { stdout: `Removed ${level} rule ${CLI.oneLine(p.sel, 64)}. Its playbook file is kept (ccc autopilot playbooks).\n` }
        } else {
          await editRules(hash, (raw) => {
            id = M.locateEntry(raw, p.sel).id
            return p.sub === 'move' ? M.applyMove(raw, { sel: p.sel, to: p.to }) : M.applyToggle(raw, { ...M.locateEntry(raw, p.sel), on: p.sub === 'enable' })
          })
          note = p.sub === 'move' ? 'Moved. ' : p.sub === 'enable' ? 'Switched on. ' : 'Switched off. '
        }
        await reloadRules()
        publish()
        const after = id === null ? '' : ruleAfter(level, id)
        // What the check ignored in the JSON just given (a typo such as "txt") is not in the file, so
        // the stored rule cannot warn about it: say it here, or the key is dropped without a word.
        const dropped = ignored.filter((x) => !after.includes(x)).map((x) => `  ⚠ ${CLI.oneLine(x, 300)} (not stored)\n`).join('')
        const tail = state.enabled() ? '' : 'Autopilot is off: nothing fires until ccc autopilot on.\n'
        return { stdout: `${note}${after}${dropped}${tail}` }
      })
    } catch (e) {
      if (e instanceof M.ManageError) {
        await reloadRules().catch(() => {})
        return nothingStored(e)
      }
      throw e
    }
  }

  async function cliPlaybooks(p, stdin) {
    await reloadRules()
    if (p.sub === 'list') {
      const levels = status().levels.filter((l) => !p.level || l.level === p.level)
      return { stdout: CLI.formatPlaybooks(levels) }
    }
    try {
      if (p.sub === 'show') {
        // A read shows both levels: each level that has the playbook, with a header when both do.
        const found = []
        for (const l of p.level ? [p.level] : S.LEVELS) {
          const folder = folderOf(l)
          if (!folder) continue
          const exists = await fs.lstat(M.playbookPath(folder, p.name)).then(() => true, () => false)
          if (exists) found.push({ level: l, pb: await M.readPlaybook(fs, folder, p.name) })
        }
        if (!found.length) {
          const where = (p.level ? [p.level] : S.LEVELS).map((l) => (folderOf(l) ? `${R.displayPath(folderOf(l), home)}/${R.PLAYBOOKS_DIR}` : `no ${l} rules folder`))
          return { stderr: `Playbook ${p.name} not found (${where.join(', ')}).\n`, code: 1 }
        }
        const body = (b) => (b.endsWith('\n') ? b : `${b}\n`)
        if (found.length === 1) return { stdout: body(found[0].pb.body) }
        return { stdout: found.map((f) => `--- ${f.level}: ${R.PLAYBOOKS_DIR}/${p.name}.md ---\n${body(f.pb.body)}`).join('\n') }
      }
      const w = writeLevel(p.level)
      if (w.error) return { stderr: `${w.error}\n`, code: 2 }
      const level = w.level
      const folder = folderOf(level)
      if (p.sub === 'set') {
        const t = CLI.inputText(p.input, stdin)
        if (t.error) return { stderr: `${t.error}\n`, code: 2 }
        // Create or replace: a replace names the hash of the file as it is now (the panel's check), so
        // a hand edit between the read and the rename is refused rather than lost.
        const out = await serial(async () => {
          const exists = await fs.lstat(M.playbookPath(folder, p.name)).then(() => true, () => false)
          const hash = exists ? (await M.readPlaybook(fs, folder, p.name)).hash : undefined
          await manageActs.savePlaybook({ level, name: p.name, body: t.text, create: !exists, hash })
          return exists
        })
        await reloadRules()
        publish()
        return { stdout: `${out ? 'Replaced' : 'Created'} ${R.PLAYBOOKS_DIR}/${p.name}.md in ${R.displayPath(folder, home)} (${level}).\n` }
      }
      // rm
      await serial(() => manageActs.deletePlaybook({ level, name: p.name }))
      await reloadRules()
      publish()
      return { stdout: `Deleted ${R.PLAYBOOKS_DIR}/${p.name}.md (${level}).\n` }
    } catch (e) {
      if (e instanceof M.ManageError) return nothingStored(e)
      throw e
    }
  }

  /**
   * `ccc autopilot base [show|set]` (design-v2 "base.md"): show reads both levels (or the one named);
   * set writes the level a write goes to (writeLevel), through the panel's own check, with the hash of
   * the file as it is now, so a hand edit between the read and the rename is refused, not lost. An empty
   * text removes the file.
   */
  async function cliBase(p, stdin) {
    await reloadRules()
    try {
      if (p.sub === 'show') {
        const out = []
        for (const l of p.level ? [p.level] : ['global', 'project']) {
          const folder = folderOf(l)
          if (!folder) {
            if (p.level) return { stderr: `There is no ${l} rules folder.\n`, code: 1 }
            continue
          }
          const b = await M.readBase(fs, folder)
          const where = `${R.displayPath(folder, home)}/${S.BASE_FILE}`
          out.push(b.exists ? `--- ${l}: ${where} ---\n${b.body.endsWith('\n') ? b.body : `${b.body}\n`}` : `--- ${l}: no ${where} ---\n`)
        }
        if (!out.length) return { stderr: 'No rules folder: set the app setting "Global rules folder" or the project setting "Project rules folder".\n', code: 1 }
        return { stdout: out.join('\n') }
      }
      const w = writeLevel(p.level)
      if (w.error) return { stderr: `${w.error}\n`, code: 2 }
      const level = w.level
      const folder = folderOf(level)
      // An empty argument clears the file; stdin must carry text (inputText refuses an empty one).
      const t = p.input.text !== undefined ? { text: p.input.text } : CLI.inputText(p.input, stdin)
      if (t.error) return { stderr: `${t.error}\n`, code: 2 }
      const res = await serial(async () => {
        const cur = await M.readBase(fs, folder)
        return manageActs.saveBase({ level, body: t.text, hash: cur.hash })
      })
      await reloadRules()
      publish()
      const where = `${R.displayPath(folder, home)}/${S.BASE_FILE}`
      return { stdout: res.removed ? `No ${where} now (${level}): sessions get no ${level} standing instructions.\n` : `Wrote ${where} (${level}): every Autopilot session prompt carries it after the fixed frame.\n` }
    } catch (e) {
      if (e instanceof M.ManageError) return nothingStored(e)
      throw e
    }
  }

  if (ctx.cli && typeof ctx.cli.register === 'function') {
    disposers.push(
      ctx.cli.register('autopilot', async (argv, call) => {
        const p = CLI.parse(argv)
        if (p.error) return { stderr: `${p.error}\n`, code: 2 }
        if (p.cmd === 'help') return { stdout: CLI.HELP }
        if (p.cmd === 'format') return { stdout: F.formatText() }
        // The first refresh has per-call limits; this deadline is the belt to them.
        let timer
        await Promise.race([first, new Promise((r) => { timer = timers.setTimeout(r, opts.cliWaitMs ?? CLI_WAIT_MS) })])
        timers.clearTimeout(timer)
        try {
          switch (p.cmd) {
            case 'status':
              await reloadRules()
              return { stdout: CLI.formatStatus(status()) }
            case 'on': {
              const n = await setEnabled(true)
              return { stdout: `Autopilot is on. Baseline: ${n} item${n === 1 ? '' : 's'} in the feeds now will not fire; new or changed ones will.\n` }
            }
            case 'off':
              await setEnabled(false)
              return { stdout: 'Autopilot is off: nothing fires (ccc autopilot test still works).\n' }
            case 'log':
              return { stdout: CLI.formatLog(state.recent(), p.n) }
            case 'reload':
              await reloadRules()
              publish()
              return { stdout: CLI.formatReload(status()) }
            case 'stop':
              return stopRun(p.run, call && call.tabId)
            case 'test': {
              let candidate = null
              await reloadRules()
              if (p.input) {
                const j = CLI.jsonInput(p.input, call && call.stdin)
                if (j.error) return { stderr: `${j.error}\n`, code: 2 }
                // The candidate's level decides its playbook folder and its place, so it is named
                // like a write's (the one level there is, or --project / --global).
                const w = writeLevel(p.level)
                if (w.error) return { stderr: `${w.error}\n`, code: 2 }
                // No id needed for a try-out; one that names a stored rule tests that rule's edit.
                const c = await checkedRule({ id: 'candidate', ...j.value }, w.level)
                if (c.error) return { stderr: `${c.error}\n`, code: 1 }
                candidate = { rule: c.rule, warnings: c.warnings, at: p.at ?? null, level: w.level }
              }
              // `--project down` names project:down; `--project` alone keeps that level's rows.
              const sel = p.rule && p.level && !p.rule.includes(':') ? S.refOf(p.level, p.rule) : p.rule
              const d = await dryRun(sel, p.jev, candidate, !p.rule && !candidate ? p.level || null : null)
              publish()
              if (d.error) return { stderr: `${d.error}\n`, code: 1 }
              return { stdout: CLI.formatDry(d) }
            }
            case 'rules':
              return await cliRules(p, call && call.stdin)
            case 'playbooks':
              return await cliPlaybooks(p, call && call.stdin)
            case 'base':
              return await cliBase(p, call && call.stdin)
            default:
              return { stderr: `${CLI.USAGE}\n`, code: 2 }
          }
        } catch (e) {
          return { stderr: `${p.cmd} failed: ${why(e)}\n`, code: 1 }
        }
      })
    )
  }

  /**
   * `ccc autopilot stop <run>`, run by the session itself (its frame names the command): nothing more
   * is delivered into its tab. Accepted only when the app says the caller IS that run's tab
   * (`CliCall.tabId`, set from the caller's session token, never from the arguments): another tab, a
   * shell, `--project` or an app before 0.11 (no tabId) is refused, so one session (or an item's text
   * talking it into a command) can never silence another run, and a guessed run id is worth nothing.
   */
  async function stopRun(runId, tabId) {
    if (typeof tabId !== 'string' || !tabId) return { stderr: 'stop is accepted only from the run\'s own Claude tab (this call comes from no Claude tab, or the app is older than cc-cockpit 0.11)\n', code: 1 }
    const found = runs.byRunId(runId)
    if (!found || found.record.tabId !== tabId) {
      // One answer for both: a tab learns nothing about other runs.
      await log({ at: now(), step: 'run', rule: found ? found.record.rule : '', source: found ? found.record.source : '', itemId: found ? found.record.itemId : '', title: '', note: `stop ${CLI.oneLine(runId, 64)} refused: tab ${CLI.oneLine(tabId, 60)} is not that run's tab` })
      return { stderr: `No Autopilot run ${runId} in this tab.\n`, code: 1 }
    }
    const rec = found.record
    const was = rec.stopped
    await runs.stop(rec.source, rec.itemId)
    if (!was) await log({ at: now(), step: 'run', rule: rec.rule, source: rec.source, itemId: rec.itemId, title: '', note: `stopped by its session (run ${rec.runId}): nothing more is delivered into tab ${rec.tabId}` })
    publish()
    return { stdout: `Autopilot run ${runId} stopped: nothing more is sent to this tab.\n` }
  }

  /**
   * Stop, and release every claim this window holds (resolves when done: deactivate returns it, and
   * main gives a deactivate 5 s). On an app quit main does not wait, so the claims usually survive;
   * the same project re-adopts them through its run records after the restart (adoptClaims), and a
   * claim whose run did not survive is this project's leftover, taken over at its next fire.
   */
  function dispose() {
    disposed = true
    if (publishTimer) timers.clearTimeout(publishTimer)
    store.dispose()
    jev.dispose()
    for (const d of disposers) if (typeof d === 'function') d()
    return claims.releaseAll().then(() => {}, warn('claims'))
  }

  return { first, tick, dispose, act: onPanelMessage, dryRun, setEnabled, status, state, runs, claims, sources: { list: sourceList }, idle: () => queue }
}

let autopilot = null
exports.activate = (ctx) => {
  autopilot = createAutopilot(ctx)
  ctx.log.info('autopilot: activated')
}
exports.deactivate = () => {
  const a = autopilot
  autopilot = null
  // The claims' release is the async part: returned so main's grace covers it.
  return a ? a.dispose() : undefined
}
exports.createAutopilot = createAutopilot
