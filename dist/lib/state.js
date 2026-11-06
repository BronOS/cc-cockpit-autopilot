'use strict'
// What Autopilot keeps in ctx.storage (per project: the rules are about that project's work, and
// its host is the store's only writer, so a get-then-set here is safe):
//
// - `enabled`: the switch. Absent is off (design "v1 scope": a fresh install fires nothing).
// - `fired`: which rule fired on which item at which rev, for "once per rev" across restarts. The rule
//   is its ref (`project:r1`, `global:r1`): ids are unique per level only, so two levels' `r1` are two
//   rules here too.
//   Pruned after 14 days and capped, so an item listed forever cannot grow the store without end.
// - `opens`: the time and rule (ref) of every session opened in the last 24 h, for the per-rule `perDay`
//   and `cooldownMinutes` and the cap of 10 an hour. Per project: a global rule counts its limits in
//   each project's window separately (each window is its own autopilot). An act rule's successful
//   action is an entry too, marked `kind: 'act'`: it counts for its own rule's perDay and cooldown, and
//   never for the cap of 10 sessions an hour, which is the flood stop for Claude sessions (a burst of
//   mails marked read must not keep the next real alert from opening its session).
// - `log`: the last 200 runs and the skips worth seeing (design "Panel and CLI").
//
// Everything is cached in memory after `load()` and written through; a failed write is logged by the
// host and the memory copy stays right for this run. Values read back are checked like any input.

const KEYS = { enabled: 'enabled', fired: 'fired', opens: 'opens', log: 'log' }
const LOG_MAX = 200
const FIRED_MAX = 1000
const FIRED_DAYS = 14
const DAY = 24 * 3600000
const HOUR = 3600000
const GLOBAL_PER_HOUR = 10
// A rule ref: `project:` (8) and an id of at most 64; cut longer only for a hand-edited store.
const RULE_REF_MAX = 80

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
const time = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function firedOf(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter((e) => isObj(e) && typeof e.rule === 'string' && typeof e.source === 'string' && typeof e.id === 'string' && time(e.at) !== null).map((e) => ({ rule: str(e.rule, RULE_REF_MAX), source: str(e.source, 128), id: str(e.id, 300), rev: str(e.rev, 300), at: e.at }))
}
function opensOf(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter((e) => isObj(e) && typeof e.rule === 'string' && time(e.at) !== null).map((e) => ({ rule: str(e.rule, RULE_REF_MAX), at: e.at, ...(e.kind === 'act' ? { kind: 'act' } : {}) }))
}
function logOf(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter((e) => isObj(e) && time(e.at) !== null).slice(-LOG_MAX)
}

const keyOf = (rule, source, id) => `${rule}\u0000${source}\u0000${id}`

function createState(storage) {
  let enabled = false
  let fired = new Map()
  let opens = []
  let log = []

  const save = (key, value) => storage.set(key, value)

  return {
    async load() {
      const [e, f, o, l] = await Promise.all([storage.get(KEYS.enabled), storage.get(KEYS.fired), storage.get(KEYS.opens), storage.get(KEYS.log)])
      enabled = e === true
      fired = new Map(firedOf(f).map((x) => [keyOf(x.rule, x.source, x.id), x]))
      opens = opensOf(o)
      log = logOf(l)
    },

    enabled: () => enabled,
    async setEnabled(on) {
      enabled = on === true
      await save(KEYS.enabled, enabled)
    },

    /** The record of `rule` firing on this item, or null. */
    fired(rule, source, id) {
      return fired.get(keyOf(rule, source, id)) || null
    },
    async markFired(rule, source, id, rev, at) {
      const k = keyOf(rule, source, id)
      // Re-inserted so the Map's order stays oldest first (the cap drops from the front).
      fired.delete(k)
      fired.set(k, { rule, source, id, rev, at })
      while (fired.size > FIRED_MAX) fired.delete(fired.keys().next().value)
      await save(KEYS.fired, [...fired.values()])
    },

    /**
     * Why `rule` may not open a session at `t`, or null. The global cap first (it is the flood stop
     * for every rule together), then the rule's day count, then its cooldown.
     */
    limitReason(rule, t) {
      // The session cap counts sessions only and holds session rules only (see the header).
      const what = rule.act ? 'actions' : 'sessions'
      const one = rule.act ? 'action' : 'session'
      if (!rule.act) {
        const lastHour = opens.filter((o) => o.kind !== 'act' && t - o.at < HOUR).length
        if (lastHour >= GLOBAL_PER_HOUR) return `${GLOBAL_PER_HOUR} sessions in the last hour (all rules)`
      }
      // The ref when the rule has one (every loaded rule does); a bare id for a rule built by hand in a test.
      const name = rule.ref || rule.id
      const mine = opens.filter((o) => o.rule === name && t - o.at < DAY)
      if (mine.length >= rule.limits.perDay) return `${mine.length} ${what} in 24 h for this rule (perDay ${rule.limits.perDay})`
      const last = mine.reduce((m, o) => Math.max(m, o.at), -Infinity)
      const cool = rule.limits.cooldownMinutes * 60000
      if (cool > 0 && t - last < cool) return `cooldown: the last ${one} for this rule was ${Math.max(0, Math.floor((t - last) / 60000))} min ago (cooldownMinutes ${rule.limits.cooldownMinutes})`
      return null
    },
    /** A session opened (or, `kind` 'act', an act rule's action succeeded) for the rule at `t`. */
    async recordOpen(ruleId, t, kind) {
      opens.push({ rule: ruleId, at: t, ...(kind === 'act' ? { kind: 'act' } : {}) })
      opens = opens.filter((o) => t - o.at < DAY)
      await save(KEYS.opens, opens)
    },

    /** Add a log entry (cut to the last 200). */
    async append(entry) {
      log.push(entry)
      if (log.length > LOG_MAX) log = log.slice(-LOG_MAX)
      await save(KEYS.log, log)
    },
    /** The newest `n` entries, newest first. */
    recent(n = LOG_MAX) {
      return log.slice(-n).reverse()
    },

    /** Drop fired records over 14 days old and opens over a day old. */
    async prune(t) {
      const before = fired.size
      for (const [k, v] of fired) if (t - v.at > FIRED_DAYS * DAY) fired.delete(k)
      if (fired.size !== before) await save(KEYS.fired, [...fired.values()])
      const n = opens.length
      opens = opens.filter((o) => t - o.at < DAY)
      if (opens.length !== n) await save(KEYS.opens, opens)
    },

    // For tests.
    _sizes: () => ({ fired: fired.size, opens: opens.length, log: log.length }),
  }
}

module.exports = { KEYS, LOG_MAX, FIRED_MAX, FIRED_DAYS, GLOBAL_PER_HOUR, createState }
