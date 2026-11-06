'use strict'
// Inbox's field conditions, copied (bronos.inbox dist/lib/rules.js, design-v2 "Rules") so Autopilot
// reads the same `when` format a person already knows from the Inbox settings page; nothing is
// imported from Inbox. Comparisons are case-insensitive over NFKC lower case, plain equality, substring
// and prefix. No regular expressions: the values come from a rules file and run over every item (a
// regex would be a ReDoS risk in the host process).
//
// One file for the host (schema.js validates `when` with `conditionOf`, evaluation uses `holds`) and the
// panel (a classic script loaded before schema.js, the global `AutopilotConditions`), like schema.js: no
// require and no Node API in here. Pure: the clock comes in as `now`, the source's kind as `kind`.

;(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.AutopilotConditions = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const KINDS = ['chat', 'mail', 'issues', 'other']
  const TO = ['direct', 'group', 'cc', 'none']
  // Jira's status categories (the jira service's `category`): the three a status can belong to.
  const CATEGORIES = ['new', 'indeterminate', 'done']
  const MAX_MINUTES = 525600
  const MAX_VALUE = 200
  const MAX_IN = 50
  const MINUTE = 60000

  /**
   * The field table: which ops each field takes and what its value is.
   * `value`: `text` (a string, 1-200), `kind` / `to` (one of a fixed list), `bool`, `read` (true, false
   * or null), `minutes` (whole number 1..525600), `category` (a Jira status category). An `in` or `notIn`
   * op takes a list (1-50) of the field's value.
   *
   * The `jira.*` fields (0.4.0) are not on the item: they are the issue the item's title names, looked up
   * through the `jira` service after every other condition of the rule held (lib/jira.js, lib/match.js).
   * `isJira` below tells them apart; here they are plain fields, so the loader, the panel and the format
   * text need no special case.
   */
  const JIRA_TEXT_OPS = ['is', 'isNot', 'contains', 'in', 'notIn']
  const FIELDS = Object.freeze({
    source: { ops: ['is', 'isNot', 'in', 'notIn'], value: 'text' },
    sourceKind: { ops: ['is', 'isNot', 'in', 'notIn'], value: 'kind' },
    title: { ops: ['contains', 'notContains', 'startsWith', 'is'], value: 'text' },
    preview: { ops: ['contains', 'notContains', 'startsWith', 'is'], value: 'text' },
    'from.name': { ops: ['is', 'isNot', 'contains', 'endsWith', 'in', 'notIn'], value: 'text' },
    'from.address': { ops: ['is', 'isNot', 'contains', 'endsWith', 'in', 'notIn'], value: 'text' },
    to: { ops: ['is', 'isNot', 'in', 'notIn'], value: 'to' },
    mentionsMe: { ops: ['is'], value: 'bool' },
    read: { ops: ['is'], value: 'read' },
    'place.kind': { ops: ['is', 'isNot', 'contains', 'in', 'notIn'], value: 'text' },
    'place.name': { ops: ['is', 'isNot', 'contains', 'in', 'notIn'], value: 'text' },
    'place.status': { ops: ['is', 'isNot', 'contains', 'in', 'notIn'], value: 'text' },
    labels: { ops: ['has', 'hasNot', 'hasPrefix'], value: 'text' },
    time: { ops: ['newerThan', 'olderThan'], value: 'minutes' },
    'jira.status': { ops: JIRA_TEXT_OPS, value: 'text' },
    'jira.category': { ops: ['is', 'isNot', 'in', 'notIn'], value: 'category' },
    'jira.done': { ops: ['is'], value: 'bool' },
    'jira.mine': { ops: ['is'], value: 'bool' },
    'jira.assignee': { ops: JIRA_TEXT_OPS, value: 'text' },
    'jira.priority': { ops: JIRA_TEXT_OPS, value: 'text' },
    'jira.type': { ops: JIRA_TEXT_OPS, value: 'text' },
  })

  /** A condition on the looked-up Jira issue (not on the item itself). */
  const isJira = (cond) => typeof cond.field === 'string' && cond.field.startsWith('jira.')

  /** Case-insensitive form of a string: NFKC then lower case (a full-width "ＡＢＣ" matches "abc"). */
  const norm = (s) => String(s).normalize('NFKC').toLowerCase()

  /** One value of a condition, checked against its kind; undefined when it does not fit. */
  function oneValue(kind, v) {
    switch (kind) {
      case 'text': {
        if (typeof v !== 'string') return undefined
        const s = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()
        return s.length >= 1 && s.length <= MAX_VALUE ? s : undefined
      }
      case 'kind':
        return KINDS.includes(v) ? v : undefined
      case 'to':
        return TO.includes(v) ? v : undefined
      case 'category':
        return CATEGORIES.includes(v) ? v : undefined
      case 'bool':
        return typeof v === 'boolean' ? v : undefined
      case 'read':
        return v === true || v === false || v === null ? v : undefined
      case 'minutes':
        return Number.isInteger(v) && v >= 1 && v <= MAX_MINUTES ? v : undefined
      default:
        return undefined
    }
  }

  /**
   * A condition as stored, clean (`{ field, op, value }`), or null when any part does not fit the
   * table. The caller drops the whole rule then: dropping only the bad condition would make the rule
   * hold for more items than the person wrote it for.
   */
  function conditionOf(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const field = Object.hasOwn(raw, 'field') ? raw.field : undefined
    const op = Object.hasOwn(raw, 'op') ? raw.op : undefined
    if (typeof field !== 'string' || !Object.hasOwn(FIELDS, field)) return null
    const spec = FIELDS[field]
    if (!spec.ops.includes(op)) return null
    const v = Object.hasOwn(raw, 'value') ? raw.value : undefined
    if (op === 'in' || op === 'notIn') {
      if (!Array.isArray(v) || v.length < 1 || v.length > MAX_IN) return null
      const list = []
      for (const x of v) {
        const one = oneValue(spec.value, x)
        if (one === undefined) return null
        if (!list.some((y) => norm(y) === norm(one))) list.push(one)
      }
      return { field, op, value: list }
    }
    const one = oneValue(spec.value, v)
    return one === undefined ? null : { field, op, value: one }
  }

  /** The item's value for a field (the source's kind from `kind`); undefined when the item has none. */
  function fieldOf(item, field, kind) {
    switch (field) {
      case 'source':
        return item.source
      case 'sourceKind':
        return kind
      case 'title':
      case 'preview':
        return item[field]
      case 'from.name':
      case 'from.address':
        return item.from ? item.from[field.slice(5)] : undefined
      case 'to':
        return item.to || 'none'
      case 'mentionsMe':
        return item.mentionsMe === true
      case 'read':
        return item.read === true || item.read === false ? item.read : null
      case 'place.kind':
      case 'place.name':
      case 'place.status':
        return item.place ? item.place[field.slice(6)] : undefined
      case 'labels':
        return Array.isArray(item.labels) ? item.labels : []
      case 'time':
        return item.time
      // The looked-up issue rides on the item as `jira` (lib/match.js sets it only after the lookup).
      // done and mine are strictly true/false so a bool condition compares like mentionsMe does.
      case 'jira.done':
      case 'jira.mine':
        return Boolean(item.jira) && item.jira[field.slice(5)] === true
      case 'jira.status':
      case 'jira.category':
      case 'jira.assignee':
      case 'jira.priority':
      case 'jira.type':
        return item.jira ? item.jira[field.slice(5)] : undefined
      default:
        return undefined
    }
  }

  // A condition's value, normalised once (NFKC + lower case): `holds` runs per item per condition, and an
  // `in` list can hold 50 values, so normalising there costs millions of calls per refresh at the caps.
  const wants = new WeakMap()
  function wantOf(cond) {
    let w = wants.get(cond)
    if (w === undefined) {
      w = Array.isArray(cond.value) ? cond.value.map(norm) : norm(cond.value)
      wants.set(cond, w)
    }
    return w
  }

  /** Whether one condition holds for an item at `now`. */
  function holds(cond, item, kind, now) {
    const actual = fieldOf(item, cond.field, kind)
    const { op, value } = cond
    if (cond.field === 'time') {
      if (typeof actual !== 'number' || !Number.isFinite(actual)) return false
      const age = now - actual
      return op === 'newerThan' ? age < value * MINUTE : age > value * MINUTE
    }
    if (cond.field === 'labels') {
      const want = wantOf(cond)
      if (op === 'hasPrefix') return actual.some((l) => norm(l).startsWith(want))
      const has = actual.some((l) => norm(l) === want)
      return op === 'has' ? has : !has
    }
    if (typeof value === 'boolean' || value === null) return actual === value
    // Text (and the enum fields, compared the same way). An absent field contains nothing, so it
    // holds only for the negative ops.
    const a = typeof actual === 'string' ? norm(actual) : null
    const w = wantOf(cond)
    switch (op) {
      case 'is':
        return a !== null && a === w
      case 'isNot':
        return a === null || a !== w
      case 'in':
        return a !== null && w.includes(a)
      case 'notIn':
        return a === null || !w.includes(a)
      case 'contains':
        return a !== null && a.includes(w)
      case 'notContains':
        return a === null || !a.includes(w)
      case 'startsWith':
        return a !== null && a.startsWith(w)
      case 'endsWith':
        return a !== null && a.endsWith(w)
      default:
        return false
    }
  }

  /** A condition as the row's reason says it: `from.address is lead@example.com`, `to in direct, group`. */
  function conditionText(cond) {
    const v = Array.isArray(cond.value) ? cond.value.map(String).join(', ') : String(cond.value)
    return `${cond.field} ${cond.op} ${v}`
  }

  /** What the item has for the condition's field, short, for the trace ("was: false"). */
  function actualText(cond, item, kind, now) {
    const a = fieldOf(item, cond.field, kind)
    if (a === undefined) return 'none'
    if (Array.isArray(a)) return a.length ? a.join(', ').slice(0, 80) : 'none'
    if (cond.field === 'time') return `${Math.max(0, Math.round((now - a) / MINUTE))} min ago`
    return String(a).slice(0, 80)
  }

  return { KINDS, TO, CATEGORIES, FIELDS, isJira, MAX_IN, MAX_VALUE, MAX_MINUTES, norm, conditionOf, conditionText, actualText, holds, fieldOf }
})
