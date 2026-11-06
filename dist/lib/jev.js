'use strict'
// Jev answers for rules (design-v2 "Rules": the Jev part, "Jev waits, unlike Inbox"). Copied from
// Inbox's lib/jev.js and cut down to what Autopilot needs; nothing is imported from Inbox.
//
// - The answer is a `noul` score 0..1 for the rule's question over `title + "\n" + preview` (cut to
//   1500 characters; design "Safety": a Jev question sees the title and preview only, never the
//   playbook), asked through `ctx.services.use('jev').grid(...)`, resolved on every call (the app's
//   rule: never a cached provider handle).
// - Cached in Autopilot's own ctx.appStorage per question and item: `jv:<hash(question)>:<hash(pluginId,
//   id)>` → `{ rev, score, at, seen }`, the same key shape as Inbox but a separate store (each plugin's
//   appStorage is its own). The `rev` is the item's content version: a new rev asks again, a read or
//   label change keeps rev and does not. The threshold is not in the key (changing `min` needs no new
//   answer); editing the question does (new hash). `seen` is the "last used" date for the prune (14
//   days, as Inbox), bumped at most once a day: the key is hashed, so nothing else ties it to an item.
// - `answer()` is synchronous (the evaluation runs over all rules in one pass): a cache hit is
//   `{ score }`, a miss queues the item and is `{ pending: true }`. Unlike Inbox the caller does not
//   move on: the item's decision waits for this answer (lower rules do not fire meanwhile), and
//   `onAnswer(refs)` tells the host which items to decide again. Pending items are asked in batches,
//   one `grid` per question at a time, at most one every 2 s, 100 items a call.
// - Unavailable (no `jev` provider, a full queue, a rejected call, a call past 45 s, a missing or
//   hostile answer) is `{ unavailable: reason }`: nothing is cached, the item is not asked again for
//   10 minutes, and when those are up `onAnswer` hands it back so the host decides again and this asks
//   anew. Never "does not hold": falling through would let a lower rule fire on an item a higher one
//   may own. A failed call also notifies at once, so the host logs the retry when it happens.
// - `cached()` is for "also matched" and the dry run without --jev: cached answers only, never a
//   request (design: no request is made for the log).
// - `ask()` is the dry run's await of one answer (queued like any other, so it lands in the cache
//   and the live path gets it for free).
// - Two windows may both ask for an item before either wrote the cache: a duplicate request, the same
//   kind of answer, the last write wins (appStorage has no compare-and-set).

const crypto = require('node:crypto')

const PREFIX = 'jv:'
const TEXT_MAX = 1500
const BATCH = 100
const PACE_MS = 2000
const RETRY_MS = 10 * 60000
const KEEP_MS = 14 * 24 * 3600000
const SEEN_EVERY_MS = 24 * 3600000
// The services layer sets no deadline ("a consumer races its own"): a grid that never settles would
// hold its lane for good. 45 s is also the design's bound on how long a decision waits.
const CALL_TIMEOUT_MS = 45000
// Per question: past this many waiting requests an item is unavailable (retried in 10 minutes), a
// bound on memory and on the calls one burst can start.
const QUEUE_MAX = 2000
const QID = 'q'
const NO_PROVIDER = 'no enabled plugin provides the jev service (bronos.jev)'

const hash = (s, n) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n)
const why = (e) => String((e && e.message) || e || 'failed').slice(0, 200)

/** The cache key of one question over one item (52 characters, inside the store's key rule). */
function cacheKey(question, pluginId, id) {
  return `${PREFIX}${hash(String(question), 16)}:${hash(`${pluginId}\u0000${id}`, 32)}`
}

/** What Jev reads: the title, a newline and the preview, cut to 1500 characters (not mid-pair). */
function textOf(item) {
  const title = typeof item.title === 'string' ? item.title : ''
  const preview = typeof item.preview === 'string' && item.preview ? item.preview : ''
  let text = preview ? `${title}\n${preview}` : title
  if (text.length > TEXT_MAX) {
    text = text.slice(0, TEXT_MAX)
    // A cut between the halves of a surrogate pair would leave a lone half (an emoji in a title).
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
  }
  return text
}

const isScore = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
const isEntry = (v) => typeof v === 'object' && v !== null && typeof v.rev === 'string' && isScore(v.score) && Number.isFinite(v.at)
const revOf = (item) => (typeof item.rev === 'string' ? item.rev : '')

/** The score in one grid result, or null: `results[gid].answers.q.noul`, a number 0..1. */
function scoreOf(result, gid) {
  const results = result && typeof result === 'object' ? result.results : null
  const r = results && typeof results === 'object' && Object.prototype.hasOwnProperty.call(results, gid) ? results[gid] : null
  const a = r && typeof r === 'object' && r.answers && typeof r.answers === 'object' ? r.answers[QID] : null
  const v = a && typeof a === 'object' ? a.noul : undefined
  return isScore(v) ? v : null
}

/**
 * The Jev answers over one app-wide store.
 * - `store`: ctx.appStorage; `services`: ctx.services (only `use('jev')` and `available('jev')`).
 * - `onAnswer(refs)`: `[{ pluginId, id }]` whose answer (or unavailability) just changed.
 * - `now`, `timers` (`{ setTimeout, clearTimeout }`, the host's pair) and `log` ({ warn }).
 */
function createJev({ store, services, onAnswer = () => {}, now = () => Date.now(), timers, log } = {}) {
  const T = timers || { setTimeout, clearTimeout }
  const warn = (msg) => {
    try {
      if (log && typeof log.warn === 'function') log.warn(msg)
    } catch {}
  }
  /** cache key → `{ rev, score, at, seen }`, as of the last load plus this window's own answers. */
  let cache = new Map()
  /** cache key → `{ until, reason, rev }`: not asked again before `until` (unavailable). */
  const blocked = new Map()
  /** cache key → the 10-minute retry timer (one per key: a second failure does not stack timers). */
  const retries = new Map()
  /** question → `{ queue: Map(key → request), inFlight: Map(key → request), timer, callTimer, lastAt }`. */
  const lanes = new Map()
  /** cache key → resolvers of `ask()` waiting for that key's next result. */
  const waiters = new Map()
  let disposed = false

  function available() {
    try {
      return Boolean(services && typeof services.available === 'function' && services.available('jev'))
    } catch {
      return false
    }
  }

  async function load() {
    const started = now()
    const next = new Map()
    for (const k of await store.keys()) {
      if (!k.startsWith(PREFIX)) continue
      const v = await store.get(k)
      if (isEntry(v)) next.set(k, v)
    }
    // Answers this window got while the load ran stay (a slow load must not drop them).
    for (const [k, v] of cache) if (!next.has(k) && v.at >= started) next.set(k, v)
    cache = next
    return cache.size
  }

  /** A cached score for this rev, bumping `seen` at most once a day (best effort, read before write as Inbox). */
  function hit(key, item) {
    const e = cache.get(key)
    if (!e || e.rev !== revOf(item)) return null
    const t = now()
    if (t - (e.seen || e.at) > SEEN_EVERY_MS) {
      const next = { rev: e.rev, score: e.score, at: e.at, seen: t }
      cache.set(key, next)
      Promise.resolve()
        .then(() => store.get(key))
        .then((stored) => {
          // Another window stored an answer for a newer rev meanwhile: keep it, never write the old rev back.
          if (isEntry(stored) && stored.rev !== next.rev) {
            if (cache.get(key) === next) cache.set(key, stored)
            return undefined
          }
          return store.set(key, next)
        })
        .catch(() => {})
    }
    return { score: e.score }
  }

  function notify(refs) {
    if (disposed || !refs.length) return
    try {
      onAnswer(refs)
    } catch {}
  }

  function settle(key, result) {
    const list = waiters.get(key)
    if (!list) return
    waiters.delete(key)
    for (const fn of list) fn(result)
  }

  /** Mark one key unavailable for 10 minutes and hand its item back when they are up. */
  function block(key, ref, rev, reason) {
    blocked.set(key, { until: now() + RETRY_MS, reason, rev })
    settle(key, { unavailable: reason })
    if (disposed || retries.has(key)) return
    const timer = T.setTimeout(() => {
      retries.delete(key)
      notify([ref])
    }, RETRY_MS)
    retries.set(key, timer)
  }

  function laneOf(question) {
    let lane = lanes.get(question)
    if (!lane) {
      lane = { queue: new Map(), inFlight: new Map(), timer: null, callTimer: null, lastAt: -Infinity }
      lanes.set(question, lane)
    }
    return lane
  }

  /** Arm the lane's timer: at once for a fresh lane, else 2 s after its last call; never beside a call in flight. */
  function arm(question, lane) {
    if (disposed || lane.timer !== null || lane.inFlight.size || !lane.queue.size) return
    const wait = Math.max(0, lane.lastAt + PACE_MS - now())
    lane.timer = T.setTimeout(() => {
      lane.timer = null
      void flush(question, lane)
    }, wait)
  }

  async function flush(question, lane) {
    if (disposed) return
    const batch = [...lane.queue.values()].slice(0, BATCH)
    if (!batch.length) return
    for (const r of batch) {
      lane.queue.delete(r.key)
      lane.inFlight.set(r.key, r)
    }
    lane.lastAt = now()
    const grid = batch.map((r, i) => ({ id: String(i), text: r.text }))
    let result = null
    let failed = null
    try {
      const handle = services.use('jev')
      const timeout = new Promise((_, reject) => {
        lane.callTimer = T.setTimeout(() => reject(new Error(`no answer in ${CALL_TIMEOUT_MS / 1000} s`)), CALL_TIMEOUT_MS)
      })
      // A late answer or rejection of a timed-out call is dropped (race keeps it handled).
      result = await Promise.race([Promise.resolve(handle.grid(grid, { [QID]: { type: 'noul', instructions: question } }, { label: 'autopilot' })), timeout])
    } catch (e) {
      failed = e
      warn(`autopilot: Jev unavailable for "${question.slice(0, 60)}": ${why(e)}`)
    } finally {
      if (lane.callTimer !== null) T.clearTimeout(lane.callTimer)
      lane.callTimer = null
    }
    if (disposed) return
    const t = now()
    const refs = []
    const writes = []
    for (const [i, r] of batch.entries()) {
      lane.inFlight.delete(r.key)
      const ref = { pluginId: r.pluginId, id: r.id }
      refs.push(ref)
      const score = failed ? null : scoreOf(result, String(i))
      if (score === null) {
        block(r.key, ref, r.rev, failed ? `jev failed: ${why(failed)}` : 'jev gave no score')
        continue
      }
      blocked.delete(r.key)
      const entry = { rev: r.rev, score, at: t, seen: t }
      cache.set(r.key, entry)
      settle(r.key, { score })
      writes.push(
        Promise.resolve()
          .then(() => store.set(r.key, entry))
          .catch((e) => warn(`autopilot: could not cache a Jev answer: ${why(e)}`)),
      )
    }
    // In parallel: a slow store must not hold the decisions for 100 serial writes.
    await Promise.all(writes)
    if (disposed) return
    notify(refs)
    arm(question, lane)
  }

  /**
   * The answer for `rule.jev.question` over the item of `pluginId`: `{ score }` when cached for this
   * rev, `{ unavailable: reason }` (no provider, a full queue, or a failure in the last 10 minutes),
   * else `{ pending: true }` with the item queued.
   */
  function answer(rule, pluginId, item) {
    const question = rule && rule.jev && rule.jev.question
    if (typeof question !== 'string' || !question) return { unavailable: 'the rule has no Jev question' }
    const key = cacheKey(question, pluginId, item.id)
    const got = hit(key, item)
    if (got) return got
    const ref = { pluginId, id: item.id }
    const rev = revOf(item)
    const b = blocked.get(key)
    // Blocked for this item whatever its rev: a newer rev of an item whose question just failed
    // waits the same 10 minutes (the failure is Jev's, not the item's).
    if (b && now() < b.until) return { unavailable: b.reason }
    if (b) blocked.delete(key)
    if (!available()) {
      block(key, ref, rev, `jev unavailable: ${NO_PROVIDER}`)
      return { unavailable: `jev unavailable: ${NO_PROVIDER}` }
    }
    const lane = laneOf(question)
    const flying = lane.inFlight.get(key)
    if (flying && flying.rev === rev) return { pending: true }
    const queued = lane.queue.get(key)
    if (!queued && lane.queue.size >= QUEUE_MAX) {
      block(key, ref, rev, `jev unavailable: more than ${QUEUE_MAX} questions waiting`)
      return { unavailable: `jev unavailable: more than ${QUEUE_MAX} questions waiting` }
    }
    // A newer rev replaces the queued one (only the latest content is worth asking about).
    if (!queued || queued.rev !== rev) lane.queue.set(key, { key, rev, pluginId, id: item.id, text: textOf(item) })
    arm(question, lane)
    return { pending: true }
  }

  /** The cached score for this rev, or null; never a request (also matched, the dry run without --jev). */
  function cached(rule, pluginId, item) {
    const question = rule && rule.jev && rule.jev.question
    if (typeof question !== 'string' || !question) return null
    const e = cache.get(cacheKey(question, pluginId, item.id))
    return e && e.rev === revOf(item) ? { score: e.score } : null
  }

  /** `answer()`, awaited: resolves `{ score }` or `{ unavailable }` (the dry run with --jev). */
  function ask(rule, pluginId, item) {
    const a = answer(rule, pluginId, item)
    if (!a.pending) return Promise.resolve(a)
    const key = cacheKey(rule.jev.question, pluginId, item.id)
    return new Promise((resolve) => {
      const list = waiters.get(key) || []
      list.push(resolve)
      waiters.set(key, list)
    })
  }

  /** Drop answers not used for 14 days (Inbox's rule: `seen` is bumped on every use, once a day). */
  async function prune() {
    const t = now()
    for (const [k, e] of [...cache]) {
      if (t - (e.seen || e.at) <= KEEP_MS) continue
      cache.delete(k)
      await store.delete(k)
    }
  }

  /** Stop every timer; answers that arrive later are dropped, and `ask()` waiters resolve unavailable. */
  function dispose() {
    disposed = true
    for (const lane of lanes.values()) {
      if (lane.timer !== null) T.clearTimeout(lane.timer)
      if (lane.callTimer !== null) T.clearTimeout(lane.callTimer)
    }
    lanes.clear()
    for (const t of retries.values()) T.clearTimeout(t)
    retries.clear()
    for (const k of [...waiters.keys()]) settle(k, { unavailable: 'Autopilot stopped' })
  }

  /** Requests waiting or in flight, for tests. */
  const pending = () => [...lanes.values()].reduce((n, l) => n + l.queue.size + l.inFlight.size, 0)

  return { load, answer, cached, ask, prune, dispose, pending, available }
}

module.exports = { createJev, cacheKey, textOf, scoreOf, PREFIX, TEXT_MAX, BATCH, PACE_MS, RETRY_MS, KEEP_MS, CALL_TIMEOUT_MS, QUEUE_MAX }
