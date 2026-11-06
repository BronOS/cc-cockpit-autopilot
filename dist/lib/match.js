'use strict'
// Which rule an item belongs to (design-v2 "Rules"): first rule wins, Jev waits. Pure, so the live path
// and the dry run decide the same way; the Jev answers come in through two functions (lib/jev.js
// `answer` and `cached`), the clock as `now`, the source's kind as `kindOf`. The field conditions are
// lib/conditions.js (Inbox's format).
//
// Per rule, cheapest first: enabled, sources, hours, field conditions, Jev. So an item outside a
// rule's hours costs no Jev request, and an item of another source never reads the conditions.
// - The first rule that holds is the item's rule (rule order is priority, the person's to set).
// - A rule whose fields hold but whose Jev answer is still pending holds the decision: `wait`, and
//   no lower rule fires meanwhile (Autopilot cannot "move" a session the way Inbox moves a row, so
//   a lower rule firing first would be a session the higher rule may have owned).
// - Jev unavailable is `retry` for the same reason: never "does not hold", never a fall-through.
// - "Also matched": the rules after the winner that would hold too, judged from field conditions and
//   CACHED Jev answers only (no request is made for a log line). They never run.
// - `trace`: rules whose sources and fields held but which did not hold for another reason (off,
//   outside their hours, a Jev score under `min`), for the log and the dry run. Reading the fields of
//   an off or out-of-hours rule for this costs nothing (no request).
// - An act rule (0.3.0) holds only for a NEW item (`o.isNew`; an update never runs an item action) whose
//   current `actions` include the rule's action. Both are checked after the fields and before Jev (free
//   before paid); either one failing is a non-match, so the next rule may take the item: the rule
//   cannot do its one thing here, and holding the item for it would help nobody. A missing action is a
//   `trace` step (`action`) the log and the dry run show; an update is step `update`, kept out of the
//   log (every chat reply would add a line).

const { holds, conditionText } = require('./conditions')
const { ANY_SOURCE, inHours, hoursLabel } = require('./schema')

const sourceHolds = (rule, pluginId) => rule.sources.includes(ANY_SOURCE) || rule.sources.includes(String(pluginId))

/**
 * Do the rule's sources and `when` conditions hold for the v2 item of `pluginId`? `null` when not,
 * else `{ why }`: one short line per part that held (the source, each condition), which the dry run
 * and the log show. `o.kindOf(pluginId)` is the provider's kind (null: "other"), `o.now` the clock.
 */
function matchRule(rule, pluginId, item, o = {}) {
  if (!sourceHolds(rule, pluginId)) return null
  const why = [rule.sources.includes(ANY_SOURCE) ? 'any source' : `source ${pluginId}`]
  const kind = (typeof o.kindOf === 'function' && o.kindOf(pluginId)) || 'other'
  const now = Number.isFinite(o.now) ? o.now : Date.now()
  // `source` from the registry's plugin id, never from the item's data (the store sets it the same way).
  const it = { ...item, source: pluginId }
  for (const c of rule.when) {
    if (!holds(c, it, kind, now)) return null
    why.push(conditionText(c))
  }
  return { why }
}

const isScore = (v) => typeof v === 'number' && Number.isFinite(v)

/** The ids of the item's current actions (lib/feed.js checked them). */
const actionIds = (item) => (Array.isArray(item && item.actions) ? item.actions.map((a) => a && a.id).filter((x) => typeof x === 'string') : [])

/**
 * Why an act rule cannot run on this item, as a trace step, or null when it can (a session rule: always
 * null). `isNew(pluginId, item)`: the live path's store answer; absent means new (the dry run's
 * question is "would it fire on this item", so every current item is judged as if it had just come in).
 */
function actBlock(rule, pluginId, item, isNew) {
  if (!rule.act) return null
  if (typeof isNew === 'function' && !isNew(pluginId, item)) return { step: 'update', skip: `an act rule runs on new items only; this is a change of one (rev ${String(item.rev).slice(0, 60)})` }
  const ids = actionIds(item)
  if (!ids.includes(rule.act)) return { step: 'action', skip: `${rule.act} is not among the item's actions now (${ids.length ? ids.join(', ') : 'none'}): the rule does not hold, the next one may take the item` }
  return null
}

/**
 * The decision for one item over `rules` in order. `o`: `kindOf(pluginId)`, `now` (ms),
 * `jevAnswer(rule, pluginId, item)` → `{ score } | { pending } | { unavailable }` (may queue a
 * request), `jevCached(rule, pluginId, item)` → `{ score } | null` (never a request), `isNew(pluginId,
 * item)` → boolean (an act rule's trigger; absent: every item is new).
 *
 * Answers `{ decision, rule, why, score?, reason?, also, trace }`:
 * - `fire`: `rule` holds (`score` when it has a Jev part); `also` lists `{ rule, why, score? }`.
 * - `wait`: `rule`'s Jev answer is pending; decide again when it comes (lib/jev.js `onAnswer`).
 * - `retry`: `rule`'s Jev is unavailable (`reason`); decide again in 10 minutes.
 * - `none`: no rule holds (`rule` null).
 * `trace` lists `{ rule, step: 'off' | 'hours' | 'update' | 'action' | 'jev', why, score?, skip }` for the rules before the
 * decision that matched on fields but did not hold.
 */
function evaluate(rules, pluginId, item, o = {}) {
  const m = { kindOf: o.kindOf, now: Number.isFinite(o.now) ? o.now : Date.now() }
  const jevAnswer = o.jevAnswer || (() => ({ unavailable: 'jev unavailable' }))
  const jevCached = o.jevCached || (() => null)
  const trace = []
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    if (!rule.enabled) {
      const f = matchRule(rule, pluginId, item, m)
      if (f) trace.push({ rule, step: 'off', why: f.why, skip: 'the rule is off' })
      continue
    }
    if (!sourceHolds(rule, pluginId)) continue
    if (!inHours(rule.hours, m.now)) {
      const f = matchRule(rule, pluginId, item, m)
      if (f) trace.push({ rule, step: 'hours', why: f.why, skip: `outside hours ${hoursLabel(rule.hours)}` })
      continue
    }
    const f = matchRule(rule, pluginId, item, m)
    if (!f) continue
    const blocked = actBlock(rule, pluginId, item, o.isNew)
    if (blocked) {
      trace.push({ rule, ...blocked, why: f.why })
      continue
    }
    let score
    if (rule.jev) {
      const a = jevAnswer(rule, pluginId, item) || {}
      if (a.pending) return { decision: 'wait', rule, why: f.why, also: [], trace }
      if (!isScore(a.score)) return { decision: 'retry', rule, why: f.why, reason: String(a.unavailable || 'jev unavailable'), also: [], trace }
      score = a.score
      if (score < rule.jev.min) {
        trace.push({ rule, step: 'jev', why: f.why, score, skip: `jev ${score.toFixed(2)} is below ${rule.jev.min}` })
        continue
      }
    }
    const also = alsoMatched(rules.slice(i + 1), pluginId, item, m, jevCached, o.isNew)
    return { decision: 'fire', rule, why: f.why, ...(score !== undefined ? { score } : {}), also, trace }
  }
  return { decision: 'none', rule: null, why: [], also: [], trace }
}

/** The rules after the winner that hold on fields and cached answers alone (a Jev rule with no cached answer is left out). */
function alsoMatched(rest, pluginId, item, m, jevCached, isNew) {
  const out = []
  for (const rule of rest) {
    if (!rule.enabled || !sourceHolds(rule, pluginId) || !inHours(rule.hours, m.now)) continue
    const f = matchRule(rule, pluginId, item, m)
    if (!f || actBlock(rule, pluginId, item, isNew)) continue
    if (rule.jev) {
      const c = jevCached(rule, pluginId, item)
      if (!c || !isScore(c.score) || c.score < rule.jev.min) continue
      out.push({ rule, why: f.why, score: c.score })
    } else out.push({ rule, why: f.why })
  }
  return out
}

const looksLikeMail = (pluginId, kindOf) => kindOf(pluginId) === 'mail' || /mail/i.test(pluginId)

/**
 * A warning when people outside can reach the rule's trigger (design "Safety", "Who can trigger"):
 * any mail source (anyone can send you an email, and `from` is easy to fake), or `sources: ["*"]` (mail
 * included). `kindOf(pluginId)` is the provider's described kind, or null for one not running now; a
 * plugin id with "mail" in it counts as mail either way. `null`: none.
 */
function outsiderWarning(rule, kindOf) {
  // An act rule starts no session (no Claude reads the outsider's text, so there is nothing to inject
  // into), but an outsider can still make it run its action: a faked mail that matches is marked read
  // or done, and the person may never see it. Worded for what can happen.
  const what = rule.act ? `make it run ${rule.act} on their item (a mail made to match is ${rule.act === 'markRead' ? 'marked read' : `handled with ${rule.act}`} unseen)` : 'start a session'
  if (rule.sources.includes(ANY_SOURCE)) return `outsiders can trigger this rule: its sources are any source, so any feed, mail included, can ${what}`
  const mail = rule.sources.filter((id) => looksLikeMail(id, kindOf))
  if (!mail.length) return null
  return `outsiders can trigger this rule: ${mail.join(', ')} is mail, and anyone who can send you an email can ${what}`
}

module.exports = { matchRule, evaluate, outsiderWarning, actionIds, actBlock }
