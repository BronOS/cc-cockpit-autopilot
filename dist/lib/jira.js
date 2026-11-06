'use strict'
// The live Jira lookup behind the `jira.*` rule conditions (0.4.0, design-v2 "Autopilot 0.4.0"): the
// issue a mail or a feed item is about, read through the optional `jira` service of bronos.jira
// (`ctx.services.use('jira').issue(key, { maxAgeMs })`), the same service bronos.gmail uses for its
// Jira mail. Without a provider nothing here runs and a rule with a jira.* condition does not hold.
//
// - The key comes from the item's TITLE by a fixed pattern (never a pattern from a rule: a regex in a rules
//   file would be a ReDoS risk in the host). A key in parentheses wins (`[JIRA] (ABC-123) Summary`, the
//   shape Jira's notification mails use), else the first key-shaped word. The parentheses matter: a
//   summary can hold key-shaped text of its own ("Support UTF-8 in exports"), and the first match of the
//   loose pattern would then be the wrong issue.
// - The decision for an item is "no" (the condition is false: no key, no provider, an issue the service
//   does not know or may not read) or "retry" (the service refused for its limits, the network failed:
//   not a statement about the issue, so never a permanent false), or the issue itself.
//   A retry is the Jev-unavailable path of lib/jev.js: the item waits, no lower rule takes it, it is
//   decided again after RETRY_MS, and after MAX_TRIES failed tries the answer becomes "no" (logged), so a
//   lookup that never works does not loop for ever.
// - One lookup per item revision, shared by every rule that asks (the issue is the same for all of them),
//   kept for TTL_MS so a same-rev event (marking read) costs nothing. In memory only, like Jev's waiting set.
// - Fresh enough: the answer must be newer than the item. `maxAgeMs` is the item's age, at least 15 s and
//   at most the service's default (5 min); the service takes 15 s to 1 h.
// - Own pacing: at most MAX_PARALLEL lookups at once and a bounded queue, so a burst of new mails does not
//   make the service refuse most of them (it allows 2 at a time and 30 a minute).
// Pure but for the service handle, the clock and the timers it is given.

const RETRY_MS = 10 * 60000
const MAX_TRIES = 4
const TTL_MS = 5 * 60000
const MIN_AGE_MS = 15000
const DEFAULT_AGE_MS = 5 * 60000
const MAX_PARALLEL = 2
const QUEUE_MAX = 200
const MAX_ENTRIES = 1000
const TITLE_SCAN = 1000

// A key as Jira Cloud has it (letters, digits, "_" in the project part, a dash, a number) inside the
// service's own limit (letters/digits/_, a dash, a number, 64 characters at most): the project part 2-50
// characters, the number without a leading zero, at most 10 digits. Both patterns are linear (a bounded
// class run, a fixed literal), run over at most TITLE_SCAN characters.
const PAREN_KEY = /\(([A-Z][A-Z0-9_]{1,49}-[1-9][0-9]{0,9})\)/
const BARE_KEY = /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9_]{1,49}-[1-9][0-9]{0,9})(?![A-Za-z0-9_])/

/** The issue key a title names (see the header), or null. */
function keyOfTitle(title) {
  if (typeof title !== 'string') return null
  const t = title.slice(0, TITLE_SCAN)
  const m = PAREN_KEY.exec(t) || BARE_KEY.exec(t)
  return m ? m[1] : null
}

// What the service says when the answer is about THIS key (or about the setup), not about load: the
// condition is then false and asking again helps nobody. The service's own wording: "not found (404)",
// "Jira says the token may not do this (403)" (an issue the token cannot see), "not an issue key",
// "not configured in this project". Anything else (busy, too many, a timeout, the network, a 5xx, a
// 429) is a retry.
const NO_ANSWER = /not found|\(404\)|\(403\)|may not do this|not an issue key|not configured|no enabled plugin provides|has no method/i

/** `{ no }` for an error that settles the question, else `{ retry }`. */
function classify(e) {
  const m = String((e && e.message) || e || 'jira lookup failed').replace(/\s+/g, ' ').trim().slice(0, 300)
  return NO_ANSWER.test(m) ? { no: m } : { retry: m }
}

const str = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) : undefined)

/** The issue's facts as the conditions read them, checked (they come from another plugin), or null. */
function issueOf(v) {
  if (!v || typeof v !== 'object' || typeof v.key !== 'string') return null
  return {
    key: str(v.key),
    status: str(v.status),
    category: str(v.category),
    done: v.done === true,
    mine: v.mine === true,
    assignee: str(v.assignee),
    priority: str(v.priority),
    type: str(v.type),
  }
}

/** The maxAgeMs for an item: its age, kept between the service's smallest sensible value and its default. */
function maxAgeFor(item, now) {
  const t = item && typeof item.time === 'number' && Number.isFinite(item.time) ? item.time : null
  if (t === null) return DEFAULT_AGE_MS
  return Math.max(MIN_AGE_MS, Math.min(DEFAULT_AGE_MS, now - t))
}

/**
 * One lookup of `key` for `item`, no cache, no timer: `{ issue }`, `{ no }` or `{ retry }`, never rejects.
 * `services`: ctx.services (only `use('jira')` and `available('jira')`).
 */
async function lookupOnce(services, key, item, now) {
  let handle
  try {
    if (!services || typeof services.available !== 'function' || !services.available('jira')) return { no: 'no enabled plugin provides the jira service in this project (bronos.jira)' }
    handle = services.use('jira')
  } catch (e) {
    return { no: `the jira service is not usable: ${String((e && e.message) || e).slice(0, 200)}` }
  }
  try {
    const issue = issueOf(await handle.issue(key, { maxAgeMs: maxAgeFor(item, now) }))
    return issue ? { issue } : { retry: 'the Jira plugin sent no issue' }
  } catch (e) {
    return classify(e)
  }
}

/**
 * The lookups over the `jira` service.
 * - `services`, `now`, `timers` (`{ setTimeout, clearTimeout }`), `log` ({ warn });
 * - `onAnswer(refs)`: `[{ pluginId, id }]` whose answer just came or whose retry is due (the host decides them again).
 *
 * `answer(pluginId, item)` (may start a lookup) resolves to `{ key, issue } | { key, no } | { key, pending } |
 * { key, retry }` (`key` null when the title has none); `cached(pluginId, item)` the same or null, never starts one.
 */
function createJira({ services, now = () => Date.now(), timers, log, onAnswer = () => {} } = {}) {
  const T = timers || { setTimeout, clearTimeout }
  const warn = (msg) => {
    try {
      if (log && typeof log.warn === 'function') log.warn(msg)
    } catch {}
  }
  /** `pluginId \0 id \0 rev` → `{ state: 'pending' | 'ok' | 'no' | 'retry', issue?, reason?, at, until?, tries }`. */
  const entries = new Map()
  const timersOf = new Map()
  const waiting = []
  let running = 0
  let disposed = false

  const keyOf = (pluginId, item) => `${pluginId}\u0000${item.id}\u0000${String(item.rev)}`

  function available() {
    try {
      return Boolean(services && typeof services.available === 'function' && services.available('jira'))
    } catch {
      return false
    }
  }

  function trim() {
    while (entries.size > MAX_ENTRIES) {
      const k = entries.keys().next().value
      entries.delete(k)
      const t = timersOf.get(k)
      if (t !== undefined) T.clearTimeout(t)
      timersOf.delete(k)
    }
  }

  function pump() {
    while (!disposed && running < MAX_PARALLEL && waiting.length) {
      const job = waiting.shift()
      running++
      job().finally(() => {
        running--
        pump()
      })
    }
  }

  function settle(k, ref, tries, r) {
    if (disposed) return
    const t = now()
    if (r.issue) entries.set(k, { state: 'ok', issue: r.issue, at: t, tries })
    else if (r.no) entries.set(k, { state: 'no', reason: r.no, at: t, tries })
    else if (tries >= MAX_TRIES) entries.set(k, { state: 'no', reason: `${r.retry}; gave up after ${tries} tries`, at: t, tries })
    else {
      entries.set(k, { state: 'retry', reason: r.retry, at: t, until: t + RETRY_MS, tries })
      // One timer per key; when it is up the item is decided again and the lookup starts again.
      const timer = T.setTimeout(() => {
        timersOf.delete(k)
        onAnswer([ref])
      }, RETRY_MS)
      timersOf.set(k, timer)
    }
    try {
      if (!r.issue && !r.no && tries < MAX_TRIES) warn(`autopilot: Jira lookup failed (${r.retry}); try ${tries} of ${MAX_TRIES}`)
      onAnswer([ref])
    } catch (e) {
      warn(`autopilot: Jira answer: ${String((e && e.message) || e)}`)
    }
  }

  function start(k, pluginId, item, key, tries) {
    const ref = { pluginId, id: item.id }
    entries.set(k, { state: 'pending', at: now(), tries })
    trim()
    if (waiting.length >= QUEUE_MAX) {
      settle(k, ref, tries + 1, { retry: `jira: more than ${QUEUE_MAX} lookups waiting` })
      return
    }
    waiting.push(() => lookupOnce(services, key, item, now()).then((r) => settle(k, ref, tries + 1, r)))
    pump()
  }

  function shape(key, e) {
    if (e.state === 'ok') return { key, issue: e.issue }
    if (e.state === 'no') return { key, no: e.reason }
    if (e.state === 'retry') return { key, retry: e.reason }
    return { key, pending: true }
  }

  function answer(pluginId, item) {
    const key = keyOfTitle(item.title)
    if (!key) return { key: null, no: 'no Jira issue key in the title' }
    if (!available()) return { key, no: 'no enabled plugin provides the jira service in this project (bronos.jira)' }
    const k = keyOf(pluginId, item)
    const e = entries.get(k)
    if (e) {
      if (e.state === 'pending') return shape(key, e)
      if (e.state === 'retry' && now() < e.until) return shape(key, e)
      if (e.state !== 'retry' && now() - e.at < TTL_MS) return shape(key, e)
      // An answer past its TTL, or a retry that is due: asked again (a settled issue may have moved on).
      entries.delete(k)
      start(k, pluginId, item, key, e.state === 'retry' ? e.tries : 0)
      return { key, pending: true }
    }
    start(k, pluginId, item, key, 0)
    return { key, pending: true }
  }

  function cached(pluginId, item) {
    const key = keyOfTitle(item.title)
    if (!key) return { key: null, no: 'no Jira issue key in the title' }
    const e = entries.get(keyOf(pluginId, item))
    if (!e || (e.state !== 'ok' && e.state !== 'no') || now() - e.at >= TTL_MS) return null
    return shape(key, e)
  }

  /** Stop every timer; answers that arrive later are dropped. */
  function dispose() {
    disposed = true
    for (const t of timersOf.values()) T.clearTimeout(t)
    timersOf.clear()
    waiting.length = 0
  }

  return { answer, cached, available, dispose }
}

module.exports = { createJira, lookupOnce, keyOfTitle, classify, issueOf, maxAgeFor, RETRY_MS, MAX_TRIES, TTL_MS, MIN_AGE_MS, DEFAULT_AGE_MS, MAX_PARALLEL, QUEUE_MAX }
