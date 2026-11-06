'use strict'
// What the `inbox-feed` v2 providers answer, checked and capped (bronos.inbox design-v2 "The feed
// contract" and "The item"; copied from Inbox's lib/feed.js, adapted). Since 0.3.0 an act rule calls
// one feed action (`act(id, action)`, only an id in the item's current `actions`), so `actReplyOf` is
// back, as Inbox has it.
// Every provider is another plugin, so its answers are untrusted input: a value of the
// wrong type is dropped (or the whole answer turns into a source error), strings are cut, arrays
// capped, unknown fields left out, and nothing here ever throws on a hostile answer. The panel
// renders every string as text; colours are names from a fixed palette, never CSS.

const CAPS = { perSource: 1000, gone: 500, id: 200, rev: 100, preview: 1000, name: 120, address: 254, placeStatus: 60, scope: 120, labels: 20, labelLen: 40, actions: 8, actionLabel: 40, title: 300, label: 24, badge: 6, message: 300 }
const COLORS = new Set(['green', 'red', 'blue', 'amber', 'violet', 'grey'])
const KINDS = new Set(['chat', 'mail', 'issues', 'other'])
const STATES = new Set(['ok', 'signedOut', 'error'])
const { isObj } = require('./util')
/** A one-line string cut to `max` (control characters and newlines become spaces), or null. */
function text(v, max) {
  if (typeof v !== 'string') return null
  const one = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}
/** An own property only (a hostile answer can't reach `__proto__` or a getter on the prototype). */
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined)

/** `describe()`'s answer, or a fallback built from the plugin id (a provider that answers junk still shows). */
function describeOf(raw, pluginId) {
  const fallback = { label: text(String(pluginId).split('.').pop() || 'Source', CAPS.label), badge: 'FEED', color: 'grey', kind: 'other' }
  if (!isObj(raw)) return fallback
  const label = text(own(raw, 'label'), CAPS.label)
  const badge = text(own(raw, 'badge'), CAPS.badge)
  const color = own(raw, 'color')
  const kind = own(raw, 'kind')
  // `scope`: what the source feeds, shown on its line.
  const scope = text(own(raw, 'scope'), CAPS.scope)
  return {
    label: label || fallback.label,
    badge: (badge || fallback.badge).toUpperCase(),
    color: COLORS.has(color) ? color : 'grey',
    kind: KINDS.has(kind) ? kind : 'other',
    ...(scope ? { scope } : {}),
  }
}

// ---- the item (design-v2 "The item"): item / gone / sync events and snapshot() ------------------
const TO = new Set(['direct', 'group', 'cc'])
const PLACE_KINDS = new Set(['channel', 'folder', 'project'])
const ACTION_ID = /^[a-z][A-Za-z0-9-]{0,39}$/
// Control characters (C0, DEL, C1, line and paragraph separators) never belong in an id or a label.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
/** A time key: finite and > 0 (design table). */
const posTime = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
/** An id as the table wants it: 1..max characters, no control characters, else null (refused, never cut). */
function idText(v, max) {
  return typeof v === 'string' && v.length >= 1 && v.length <= max && !CONTROL.test(v) ? v : null
}
/** A one-line string with whitespace runs collapsed to one space, cut to `max`, or null when empty or not a string. */
function line(v, max) {
  if (typeof v !== 'string') return null
  const one = v.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  if (!one) return null
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function actionsOf(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const a of raw) {
    if (out.length >= CAPS.actions) break
    if (!isObj(a)) continue
    const id = own(a, 'id')
    const label = line(own(a, 'label'), CAPS.actionLabel)
    if (typeof id !== 'string' || !ACTION_ID.test(id) || !label || seen.has(id)) continue
    seen.add(id)
    out.push({ id, label })
  }
  return out
}

function labelsOf(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const l of raw) {
    if (out.length >= CAPS.labels) break
    const t = line(l, CAPS.labelLen)
    // Compared case-insensitively: "Alert" and "alert" are one label (the first spelling is kept).
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    out.push(t)
  }
  return out
}

/**
 * One v2 FeedItem. Returns `{ item, refused }`: `item` is null and `refused` 1 when a required field (id,
 * rev, title, time) is missing or bad; optional fields of the wrong type are left out. Never throws.
 */
function itemOf(raw) {
  const bad = { item: null, refused: 1 }
  if (!isObj(raw)) return bad
  const id = idText(own(raw, 'id'), CAPS.id)
  const rev = line(own(raw, 'rev'), CAPS.rev)
  const title = line(own(raw, 'title'), CAPS.title)
  const time = posTime(own(raw, 'time'))
  if (!id || !rev || !title || time === null) return bad
  const read = own(raw, 'read')
  const out = { id, rev, title, time, mentionsMe: own(raw, 'mentionsMe') === true, read: typeof read === 'boolean' ? read : null }
  const preview = line(own(raw, 'preview'), CAPS.preview)
  if (preview) out.preview = preview
  const from = own(raw, 'from')
  if (isObj(from)) {
    const name = line(own(from, 'name'), CAPS.name)
    const address = line(own(from, 'address'), CAPS.address)
    if (name || address) out.from = { ...(name ? { name } : {}), ...(address ? { address } : {}) }
  }
  const to = own(raw, 'to')
  if (TO.has(to)) out.to = to
  const place = own(raw, 'place')
  if (isObj(place) && PLACE_KINDS.has(own(place, 'kind'))) {
    const name = line(own(place, 'name'), CAPS.name)
    const status = line(own(place, 'status'), CAPS.placeStatus)
    if (name) out.place = { kind: own(place, 'kind'), name, ...(status ? { status } : {}) }
  }
  out.labels = labelsOf(own(raw, 'labels'))
  out.actions = actionsOf(own(raw, 'actions'))
  return { item: out, refused: 0 }
}

/**
 * A `sync` / `snapshot()` answer: `{ items, state, message?, asOf, refused, overCap }`. `refused` counts items
 * left out (bad, or a duplicate id: the first wins); `overCap` counts items past 1000 (the newest by `time` stay).
 * A malformed answer is a source error with no items.
 */
function syncOf(raw) {
  if (!isObj(raw) || !Array.isArray(own(raw, 'items'))) {
    return { items: [], state: 'error', message: 'the source answered something Autopilot cannot read', asOf: null, refused: 0, overCap: 0 }
  }
  const list = own(raw, 'items')
  const seen = new Set()
  let items = []
  let refused = 0
  // Bound the work on a hostile 10-million-entry array: past twice the cap everything is counted, not parsed.
  const scan = Math.min(list.length, CAPS.perSource * 2)
  for (let i = 0; i < scan; i++) {
    const { item } = itemOf(list[i])
    if (!item || seen.has(item.id)) {
      refused++
      continue
    }
    seen.add(item.id)
    items.push(item)
  }
  let overCap = list.length - scan
  if (items.length > CAPS.perSource) {
    overCap += items.length - CAPS.perSource
    items = items.sort((a, b) => b.time - a.time).slice(0, CAPS.perSource)
  }
  const state = own(raw, 'state')
  const message = line(own(raw, 'message'), CAPS.message)
  return { items, state: STATES.has(state) ? state : 'ok', ...(message ? { message } : {}), asOf: posTime(own(raw, 'asOf')), refused, overCap }
}

/**
 * A `gone` event's data `{ ids }`: `{ ids, refused, overCap }`, 1-500 ids. Bad ids are counted in `refused`
 * (an empty or missing list counts 1: the event carried nothing usable), duplicates are folded, and only valid
 * unique ids past the 500th count in `overCap`. The scan stops after 4 times the cap (the rest is counted
 * `refused`, not parsed) so a hostile huge array costs bounded work.
 */
function goneOf(raw) {
  const ok = isObj(raw) && Array.isArray(own(raw, 'ids'))
  const list = ok ? own(raw, 'ids') : []
  const seen = new Set()
  const ids = []
  let refused = ok && list.length > 0 ? 0 : 1
  let overCap = 0
  const scan = Math.min(list.length, CAPS.gone * 4)
  refused += list.length - scan
  for (let i = 0; i < scan; i++) {
    const id = idText(list[i], CAPS.id)
    if (!id) refused++
    else if (!seen.has(id)) {
      seen.add(id)
      if (ids.length < CAPS.gone) ids.push(id)
      else overCap++
    }
  }
  return { ids, refused, overCap }
}

/**
 * An `act(id, action)` answer: `{ ok: true }` or `{ ok: false, message? }` (the message cut to one line of
 * 300). Anything else is a failure: an act rule counts against its limits only on a real `ok: true`.
 */
function actReplyOf(raw) {
  if (!isObj(raw) || typeof own(raw, 'ok') !== 'boolean') return { ok: false, message: 'the source answered something Autopilot cannot read' }
  if (own(raw, 'ok')) return { ok: true }
  const message = line(own(raw, 'message'), CAPS.message)
  return { ok: false, ...(message ? { message } : {}) }
}

/**
 * `features()`'s answer as a set of plain one-line strings (feed v2 defines no names, so later additions
 * pass through): each at most 40 characters, at most 32 of them.
 */
function featuresOf(raw) {
  const out = new Set()
  if (!Array.isArray(raw)) return out
  for (const f of raw.slice(0, 256)) {
    const t = line(f, CAPS.labelLen)
    if (t) out.add(t)
    if (out.size >= 32) break
  }
  return out
}

module.exports = { CAPS, text, describeOf, itemOf, syncOf, goneOf, actReplyOf, featuresOf }
