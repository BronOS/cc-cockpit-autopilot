'use strict'
// The rule format: its constants and the check of one rule, in ONE file that both the host
// (rules.js, manage.js, format.js) and the panel (loaded as a classic script before viewlogic.js)
// use, so the loader, the panel's form, the host's writes and `ccc autopilot format` can never
// disagree on what a valid rule is. No require and no Node API in here: in a page it becomes the
// global `AutopilotSchema` (an IIFE, so its helpers do not collide with the panel's own top-level
// names), in Node it is a module.
//
// No regexes from the person anywhere: `when` is Inbox's condition format (lib/conditions.js: fields,
// plain equality, substring and prefix), since a regex in a rule would be a ReDoS risk in the host
// process.
//
// The v2 rule (design-v2 "Rules"): id, name, enabled, sources (required), when, jev, hours, playbook
// or act (exactly one of them), mode, check, model, effort, onChange, limits.
//
// Two kinds of rule (0.3.0, design-v2 "Autopilot 0.3.0"): a SESSION rule names a `playbook` and opens a
// Claude tab (its `mode` says whether the session only investigates or may carry out the playbook's
// "Allowed actions"); an ACT rule names `act`, one of the item's own feed actions (markRead, done, ...),
// which Autopilot runs itself through the source's inbox-feed `act`, with no tab and no prompt. An act
// rule has nothing a session would read, so the session-only keys are refused on it rather than
// ignored: a `check` that silently does nothing would look like a guard the person thinks they have. v2 reads its own file, autopilot-rules.json, so a
// person's v1 rules.json next to it is never read nor written (design-v2 "Migration from v1"). An entry
// with v1's `match` or `triage` in the new file gets no special treatment: it is an invalid rule like any
// other (it has no `sources`), and its problem line says that `match` is a v1 key.
//
// Two levels (design-v2 "Two rule levels"): the project's folder and the global one, each with its own
// rules file and playbooks/. A rule is named `<level>:<id>` wherever more than one level can show (the
// log, the prompt frame, the CLI): ids are unique per level only.

;(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.AutopilotSchema = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // The condition format: a module in Node, the global of conditions.js (loaded first) in the panel.
  const C = typeof module !== 'undefined' && module.exports ? require('./conditions') : globalThis.AutopilotConditions
  const RULES_FILE = 'autopilot-rules.json'
  // v1's file. Only its presence is checked (for the hint that it is not read); it is never opened.
  const V1_RULES_FILE = 'rules.json'
  const PLAYBOOKS_DIR = 'playbooks'
  // The rule levels in the order they are checked: project rules first, then global ones (first rule wins).
  const LEVELS = Object.freeze(['project', 'global'])
  const LEVEL_LABELS = Object.freeze({ project: 'Project', global: 'Global' })
  /** A rule's name across levels: `project:r1`. A rule id has no ":" (RULE_ID), so the split is unambiguous. */
  const refOf = (level, id) => `${level}:${id}`
  const MAX_RULES = 200
  // The rules file and a playbook as the loader reads them and the panel writes them.
  const MAX_RULES_BYTES = 512 * 1024
  // A playbook is passed to Claude as one argument with the frame and the item (ctx.sessions.open):
  // 64 KiB plus the frame stays under Linux's 128 KiB per-argument limit.
  const MAX_PLAYBOOK_BYTES = 64 * 1024
  const MAX_LIST = 20
  // Only the v1 panel form (until Task 13 rewrites it) still counts needles and levels.
  const MAX_NEEDLE = 200
  const MAX_CHECK = 500
  const MAX_NAME = 60
  const MAX_WHEN = 20
  const MAX_SOURCES = 20
  const MAX_QUESTION = 1000
  // A rule id goes into the prompt, the log and the notification: a plain word.
  const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
  // A playbook name becomes `playbooks/<name>.md`: no dot, no slash, no backslash, so no `..` and
  // no path outside the folder can be named.
  const PLAYBOOK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
  // A plugin id as the app allows it: the app's PLUGIN_ID_PATTERN (src/shared/manifest.ts), copied, with its
  // 100-character cap. At least two dot-separated parts, lower case; a source id is only ever compared with
  // a provider's id, but a bad one must not reach the log or the panel as a "source".
  const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.[a-z][a-z0-9-]*$/
  const MAX_PLUGIN_ID = 100
  // `sources` that means any source, chosen explicitly (design-v2: omitting `sources` is an error, never "any").
  const ANY_SOURCE = '*'
  // The feed contract's triage levels (lib/feed.js takes them from here).
  const LEVEL_LIST = Object.freeze(['urgent', 'action', 'fyi', 'noise'])
  // A rule's model and effort: Claude Code's aliases, the same lists as core's src/shared/session-options.ts
  // (the app checks them again). Absent: the person's default. On an app without sessions.open model/effort
  // both are accepted and ignored. `fable` is the person's to choose (core accepts it since 0.11; the
  // costliest model, so the skill tells Claude never to pick it on its own).
  const MODEL_LIST = Object.freeze(['haiku', 'sonnet', 'opus', 'fable'])
  const EFFORT_LIST = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
  const LIMITS = Object.freeze({
    perDay: Object.freeze({ min: 1, max: 100, default: 10 }),
    cooldownMinutes: Object.freeze({ min: 0, max: 1440, default: 30 }),
  })
  const LIMIT_DEFAULTS = Object.freeze({ perDay: LIMITS.perDay.default, cooldownMinutes: LIMITS.cooldownMinutes.default })
  const JEV_MIN_DEFAULT = 0.7
  // An act rule's action: the inbox-feed v2 action id shape (bronos.inbox design-v2 "The item", the same
  // pattern lib/feed.js checks an item's `actions` with), so a rule can only name an id a source can offer.
  const ACTION_ID = /^[a-z][A-Za-z0-9-]{0,39}$/
  // `open` opens a window for a person to look at (an overlay, a browser tab): with nobody watching it is
  // never what an unattended rule should do, and a burst of items would open a burst of windows.
  const ACT_REFUSED = Object.freeze(['open'])
  // The keys only a session reads: refused on an act rule (see the header).
  const SESSION_KEYS = Object.freeze(['mode', 'check', 'model', 'effort', 'onChange'])
  // A session rule's mode: `investigate` (the default, the frame's "change nothing") or `act` (only the
  // actions the playbook lists under its "Allowed actions" heading). lib/prompt.js words each.
  const MODE_LIST = Object.freeze(['investigate', 'act'])
  const MODE_DEFAULT = 'investigate'
  const ALLOWED_ACTIONS = 'Allowed actions'
  // The person's standing instructions for every session (design-v2 "base.md"), one per level folder.
  // 16 KiB each: both levels' base.md plus a 64 KiB playbook, the frame and the item stay under Linux's
  // 128 KiB per-argument limit (the prompt is one argument of ctx.sessions.open).
  const BASE_FILE = 'base.md'
  const MAX_BASE_BYTES = 16 * 1024

  // In the order a rule is written (the README's example, and the panel's saves).
  const RULE_KEYS = Object.freeze(['id', 'name', 'enabled', 'sources', 'when', 'jev', 'hours', 'playbook', 'act', 'mode', 'check', 'model', 'effort', 'onChange', 'limits'])
  const JEV_KEYS = Object.freeze(['question', 'min'])
  // v1's keys. Unknown keys like any other (warned, never read), but named as v1's in the warning and in
  // the problem line of an invalid rule, since a person who copied a v1 rule over expects them to work.
  const V1_KEYS = Object.freeze(['match', 'triage'])
  const LIMIT_KEYS = Object.freeze(['perDay', 'cooldownMinutes'])
  const HOURS_KEYS = Object.freeze(['from', 'to'])
  // "HH:MM", 24-hour, two digits each. A fixed-format check by character, not a pattern from the person.
  const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/

  const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)
  /** One line, control characters out, for text the person wrote that goes into the prompt or a message. */
  const oneLine = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  const quote = (s, max = 60) => {
    const t = oneLine(s)
    return JSON.stringify(t.length > max ? `${t.slice(0, max - 1)}…` : t)
  }

  class RuleError extends Error {}
  const bad = (m) => {
    throw new RuleError(m)
  }

  function unknownKeys(obj, known, where, warnings) {
    for (const k of Object.keys(obj)) {
      if (known.includes(k)) continue
      const v1 = !where && V1_KEYS.includes(k) ? `: ${V1_NOTE}` : ''
      warnings.push(`unknown key ${quote(k, 40)}${where ? ` in ${where}` : ''} ignored${v1}`)
    }
  }
  const V1_NOTE = 'a v1 key; v2 rules use sources, when and jev (see `ccc autopilot format`)'

  /** The sources of a rule: 1-20 plugin ids, or exactly ["*"]. Duplicates are dropped (first kept). */
  function sourcesOf(raw) {
    if (raw === undefined || raw === null) bad('sources is missing: choose the sources (a plugin id such as "bronos.chat", or ["*"] for any source)')
    if (!Array.isArray(raw)) bad('sources must be a list of plugin ids (["bronos.chat"]) or ["*"]')
    if (raw.length < 1) bad('sources is an empty list: choose the sources, or ["*"] for any source')
    if (raw.length > MAX_SOURCES) bad(`sources has more than ${MAX_SOURCES} entries`)
    if (raw.includes(ANY_SOURCE)) {
      if (raw.length !== 1) bad('sources: "*" must stand alone (["*"]), not next to other ids')
      return [ANY_SOURCE]
    }
    const out = []
    for (const id of raw) {
      if (typeof id !== 'string' || id.length > MAX_PLUGIN_ID || !PLUGIN_ID.test(id)) bad(`sources must hold plugin ids ("bronos.chat", lower case, at most ${MAX_PLUGIN_ID} characters) or be ["*"]`)
      if (!out.includes(id)) out.push(id)
    }
    return out
  }

  /**
   * `when`: 0-20 conditions in Inbox's format, all must hold. One bad condition makes the rule invalid
   * (never dropped alone: the rule would then hold for more items than the person wrote it for).
   */
  function whenOf(raw) {
    if (raw === undefined || raw === null) return []
    if (!Array.isArray(raw)) bad('when must be a list of conditions ([{ "field": "title", "op": "contains", "value": "failed" }])')
    if (raw.length > MAX_WHEN) bad(`when has more than ${MAX_WHEN} conditions`)
    return raw.map((c, i) => {
      const one = C.conditionOf(c)
      if (!one) bad(`when[${i + 1}] is not a valid condition (a field, an op that field takes, and a value of its kind; see \`ccc autopilot format\`)`)
      return one
    })
  }

  /** The Jev part: one yes/no question and the threshold. Absent: null. */
  function jevOf(raw, warnings, add) {
    if (raw === undefined || raw === null) return null
    if (!isObj(raw)) bad('jev must be an object: { "question": "...", "min": 0.7 }')
    unknownKeys(raw, JEV_KEYS, 'jev', warnings)
    const q = add(() => {
      const v = own(raw, 'question')
      if (typeof v !== 'string' || !oneLine(v)) bad('jev.question is missing (a yes/no question for Jev)')
      if (oneLine(v).length > MAX_QUESTION) bad(`jev.question is over ${MAX_QUESTION} characters`)
      return oneLine(v)
    })
    const min = add(() => {
      const v = own(raw, 'min')
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) bad('jev.min must be a number from 0 to 1')
      return v === undefined ? JEV_MIN_DEFAULT : v
    })
    return q === undefined || min === undefined ? undefined : { question: q, min }
  }

  /** The limits; with `add`, each one checked on its own. */
  function limitsOf(raw, warnings, add) {
    if (raw === undefined || raw === null) return { ...LIMIT_DEFAULTS }
    if (!isObj(raw)) bad('limits must be an object ({ "perDay": 10, "cooldownMinutes": 30 })')
    unknownKeys(raw, LIMIT_KEYS, 'limits', warnings)
    const out = {}
    let ok = true
    for (const k of LIMIT_KEYS) {
      const v = add(() => {
        const x = own(raw, k)
        const { min, max } = LIMITS[k]
        if (x !== undefined && (!Number.isInteger(x) || x < min || x > max)) bad(`limits.${k} must be a whole number from ${min} to ${max}`)
        return x === undefined ? LIMITS[k].default : x
      })
      if (v === undefined) ok = false
      out[k] = v
    }
    return ok ? out : undefined
  }

  /** "HH:MM" as minutes since midnight, or -1 when it is not a 24-hour time written with two digits each. */
  const minutesOf = (v) => {
    const m = typeof v === 'string' ? CLOCK.exec(v) : null
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1
  }

  /** The active hours; with `add`, from and to are checked one by one. Absent or null: any time (null). */
  function hoursOf(raw, warnings, add) {
    if (raw === undefined || raw === null) return null
    if (!isObj(raw)) bad('hours must be an object ({ "from": "22:00", "to": "07:00" }) or left out for any time')
    unknownKeys(raw, HOURS_KEYS, 'hours', warnings)
    const t = {}
    let ok = true
    for (const k of HOURS_KEYS) {
      const v = add(() => {
        const x = own(raw, k)
        if (minutesOf(x) < 0) bad(`hours.${k} must be a 24-hour time as "HH:MM" (00:00 to 23:59)`)
        return x
      })
      if (v === undefined) ok = false
      t[k] = v
    }
    if (!ok) return undefined
    if (t.from === t.to) {
      add(() => bad('hours.from and hours.to are the same; leave hours out to run at any time'))
      return undefined
    }
    return t
  }

  /**
   * Whether `date` (a Date or a timestamp) is inside the active hours, in the local time of the
   * machine (getHours/getMinutes). `from` is inclusive, `to` exclusive; `to` before `from` crosses
   * midnight. No hours (null): always.
   */
  function inHours(hours, date) {
    if (!isObj(hours)) return true
    const f = minutesOf(hours.from)
    const t = minutesOf(hours.to)
    if (f < 0 || t < 0 || f === t) return true
    const d = date instanceof Date ? date : new Date(date)
    const n = d.getHours() * 60 + d.getMinutes()
    return f < t ? n >= f && n < t : n >= f || n < t
  }

  /** The window for a person: "22:00–07:00". */
  const hoursLabel = (hours) => `${hours.from}–${hours.to}`

  const HEADING = /^#{1,6}[ \t]/
  const ALLOWED_HEADING = /^#{1,6}[ \t]+allowed actions[ \t]*:?[ \t]*#*[ \t]*$/i
  const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+\S/
  /**
   * Does a playbook body have an "Allowed actions" section: a Markdown heading of that name (any level,
   * any case) with at least one list item under it before the next heading? An act-mode rule needs one
   * (design-v2 "Mode per session rule"): the frame lets the session do only what is listed there, so a
   * playbook without the list is a rule the person has not finished, shown as a problem and never run.
   * A list item and not any text, so a stub's comment or a sentence about the list is not a list. Line
   * by line with fixed patterns (none from the person), linear in the body's length.
   */
  function hasAllowedActions(body) {
    let inside = false
    for (const line of String(body == null ? '' : body).split('\n')) {
      if (HEADING.test(line)) {
        inside = ALLOWED_HEADING.test(line)
        continue
      }
      if (inside && LIST_ITEM.test(line)) return true
    }
    return false
  }

  /**
   * One rule checked: `{ rule, warnings, errors }`. `rule` is the whole valid rule (defaults filled
   * in) or null; `errors` lists every bad field in file order as `{ field, message }`, the field being
   * the message's first word ("sources", "jev.min", "limits.perDay"), so the panel can put each under
   * its control. The loader reports the first one. An entry with a v1 key that is invalid says so in
   * its first error (it is invalid for a v2 reason, usually the missing `sources`, but the v1 key is
   * what the person has to see to fix it).
   */
  function checkRule(raw) {
    const warnings = []
    const errors = []
    const add = (fn) => {
      try {
        return fn()
      } catch (e) {
        if (!(e instanceof RuleError)) throw e
        errors.push({ field: e.message.split(' ')[0], message: e.message })
        return undefined
      }
    }
    if (!isObj(raw)) return { rule: null, warnings, errors: [{ field: '', message: 'a rule must be an object' }] }
    const id = own(raw, 'id')
    add(() => {
      if (typeof id !== 'string' || !RULE_ID.test(id)) bad('id must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit')
    })
    unknownKeys(raw, RULE_KEYS, '', warnings)
    const name = own(raw, 'name')
    add(() => {
      if (name !== undefined && (typeof name !== 'string' || oneLine(name).length > MAX_NAME)) bad(`name must be text of at most ${MAX_NAME} characters`)
    })
    const enabled = own(raw, 'enabled')
    add(() => {
      if (enabled !== undefined && typeof enabled !== 'boolean') bad('enabled must be true or false')
    })
    const pb = own(raw, 'playbook')
    const act = own(raw, 'act')
    // An act rule: `act` and no playbook (both set is an error below, and the rule is then judged as a session one).
    const isAct = act !== undefined && pb === undefined
    const onChange = own(raw, 'onChange')
    add(() => {
      // On an act rule its presence is the error (below), whatever the value.
      if (!isAct && onChange !== undefined && typeof onChange !== 'boolean') bad('onChange must be true or false')
    })
    const sources = add(() => sourcesOf(own(raw, 'sources')))
    const when = add(() => whenOf(own(raw, 'when')))
    const jev = add(() => jevOf(own(raw, 'jev'), warnings, add))
    // Exactly one of playbook (a session) and act (an item action, no session). Both would leave it to a
    // guess whether a Claude tab opens; neither is a rule that does nothing.
    add(() => {
      if (pb !== undefined && act !== undefined) bad('playbook and act are both set: a rule either opens a session with a playbook or runs one of the item\'s actions (act), not both')
      if (pb === undefined && act === undefined) bad('playbook is missing: name a playbook (a Claude session) or an act (one of the item\'s own actions, such as markRead, with no session)')
    })
    add(() => {
      if (pb !== undefined && (typeof pb !== 'string' || !PLAYBOOK_NAME.test(pb))) bad('playbook must be a file name without ".md" (letters, digits, "_" or "-"; no dot or slash)')
    })
    add(() => {
      if (act === undefined) return
      if (typeof act !== 'string' || !ACTION_ID.test(act)) bad('act must be an action id of the item (markRead, markUnread, done, or one the source offers: a lower-case letter, then letters, digits or "-", at most 40)')
      if (ACT_REFUSED.includes(act)) bad('act cannot be "open": it opens a window for a person, which an unattended rule must not do (use a session rule to look at the item)')
    })
    const mode = own(raw, 'mode')
    const check = own(raw, 'check')
    const model = own(raw, 'model')
    const effort = own(raw, 'effort')
    if (isAct) {
      // Refused, not ignored (see the header): one error per key, under its own field.
      for (const k of SESSION_KEYS) {
        add(() => {
          if (own(raw, k) !== undefined) bad(`${k} is for a session rule: an act rule runs ${quote(act, 40)} itself and opens no session, so it has no ${k} (remove it)`)
        })
      }
    } else {
      add(() => {
        if (mode !== undefined && !MODE_LIST.includes(mode)) bad(`mode must be one of ${MODE_LIST.join(', ')} (or left out for ${MODE_DEFAULT})`)
      })
      add(() => {
        if (check === undefined) return
        if (typeof check !== 'string') bad('check must be text')
        if (oneLine(check).length > MAX_CHECK) bad(`check is over ${MAX_CHECK} characters`)
      })
      add(() => {
        if (model !== undefined && !MODEL_LIST.includes(model)) bad(`model must be one of ${MODEL_LIST.join(', ')} (or left out for your default)`)
      })
      add(() => {
        if (effort !== undefined && !EFFORT_LIST.includes(effort)) bad(`effort must be one of ${EFFORT_LIST.join(', ')} (or left out for your default)`)
      })
    }
    const hours = add(() => hoursOf(own(raw, 'hours'), warnings, add))
    const limits = add(() => limitsOf(own(raw, 'limits'), warnings, add))
    if (errors.length) {
      const v1 = V1_KEYS.find((k) => Object.hasOwn(raw, k))
      if (v1) errors[0] = { ...errors[0], message: `${errors[0].message} (${quote(v1, 10)} is ${V1_NOTE})` }
      return { rule: null, warnings, errors }
    }
    const text = typeof check === 'string' ? oneLine(check) : ''
    const rule = {
      id,
      name: typeof name === 'string' && oneLine(name) ? oneLine(name) : null,
      enabled: enabled !== false,
      sources,
      when,
      jev: jev || null,
      hours: hours || null,
      // A session rule has a playbook and a mode; an act rule an action and neither.
      playbook: isAct ? null : pb,
      act: isAct ? act : null,
      mode: isAct ? null : mode || MODE_DEFAULT,
      check: isAct ? null : text || null,
      model: isAct ? null : model || null,
      effort: isAct ? null : effort || null,
      onChange: !isAct && onChange === true,
      limits,
    }
    return { rule, warnings, errors }
  }

  /** The id of a raw entry when one can be read (an object with a string id), else null. */
  const idOf = (raw) => (isObj(raw) && typeof raw.id === 'string' ? raw.id : null)

  /**
   * The parsed rules file, validated: `{ rules, problems, entries }`. Each valid rule carries
   * `warnings` (what was ignored); each bad one is a problem line naming it and is left out.
   * Duplicate ids keep the first (the log and the once-per-item record are keyed by id).
   * `entries` has one record per entry of the file, valid or not, in file order:
   * `{ index, id, raw, rule, problem, warnings, schema }` (`schema`: the rule itself is well formed,
   * even when a duplicate id or, later, its playbook makes it a problem).
   */
  function readRules(raw) {
    const problems = []
    if (!Array.isArray(raw)) return { rules: [], problems: [`${RULES_FILE} must be a list of rules ([ {...}, ... ])`], entries: [] }
    if (raw.length > MAX_RULES) problems.push(`${RULES_FILE} has ${raw.length} rules; only the first ${MAX_RULES} are read`)
    const rules = []
    const entries = []
    const ids = new Set()
    raw.forEach((r, i) => {
      const entry = { index: i, id: idOf(r), raw: r, rule: null, problem: null, warnings: [], schema: false }
      entries.push(entry)
      if (i >= MAX_RULES) {
        entry.problem = `beyond the first ${MAX_RULES} rules: not read`
        return
      }
      const name = entry.id !== null ? `rule ${i + 1} (${quote(entry.id, 40)})` : `rule ${i + 1}`
      const c = checkRule(r)
      entry.warnings = c.warnings
      entry.schema = Boolean(c.rule)
      let problem = c.errors.length ? c.errors[0].message : null
      if (!problem && ids.has(c.rule.id)) problem = `id ${quote(c.rule.id)} is used by an earlier rule`
      if (problem) {
        entry.problem = problem
        problems.push(`${name}: ${problem}; skipped`)
        return
      }
      ids.add(c.rule.id)
      entry.rule = { ...c.rule, warnings: c.warnings }
      rules.push(entry.rule)
    })
    return { rules, problems, entries }
  }

  /** The keys of `obj` that are not in `known`, as [key, value] pairs (kept as they were on a save). */
  const extraKeys = (obj, known) => (isObj(obj) ? Object.keys(obj).filter((k) => !known.includes(k)).map((k) => [k, obj[k]]) : [])

  /**
   * A rule as it is written to the rules file: the keys in their usual order (RULE_KEYS), optional parts left
   * out when empty, `enabled`, `sources`, `limits` always written, and `playbook` and `onChange` (a session
   * rule) or `act` (an act rule). `r` is a
   * checked raw rule (the panel's form); its strings are written as given. `original` (the entry being
   * edited, or null) gives back the keys the form cannot show, an unknown key above all: a save never
   * drops something silently (the warning about it stays). Keys of a nested object the form does not
   * know (`jev`, `hours`, `limits`) are kept the same way.
   */
  function canonicalRule(r, original) {
    const orig = isObj(original) ? original : null
    const out = { id: r.id }
    if (typeof r.name === 'string' && r.name.trim()) out.name = r.name
    out.enabled = r.enabled !== false
    out.sources = Array.isArray(r.sources) ? [...r.sources] : r.sources
    if (Array.isArray(r.when) && r.when.length) out.when = r.when.map((c) => ({ field: c.field, op: c.op, value: c.value }))
    if (isObj(r.jev)) {
      out.jev = { question: r.jev.question, min: r.jev.min === undefined ? JEV_MIN_DEFAULT : r.jev.min }
      for (const [k, v] of extraKeys(orig && orig.jev, JEV_KEYS)) out.jev[k] = v
    }
    // Written only when set: no hours is any time, and the key stays out of the file.
    const h = r.hours
    if (isObj(h)) {
      out.hours = { from: h.from, to: h.to }
      for (const [k, v] of extraKeys(orig && orig.hours, HOURS_KEYS)) out.hours[k] = v
    }
    // An act rule is written with `act` and none of the session keys (checkRule refuses them on it); a
    // session rule with its playbook, and `mode` only when it is not the default (a file that never
    // says "mode" is an investigate rule, as every rule before 0.3.0).
    const isAct = typeof r.act === 'string' && r.act !== '' && (r.playbook === undefined || r.playbook === null || r.playbook === '')
    if (isAct) out.act = r.act
    else {
      out.playbook = r.playbook
      if (r.mode && r.mode !== MODE_DEFAULT) out.mode = r.mode
      if (typeof r.check === 'string' && r.check.trim()) out.check = r.check
      if (r.model) out.model = r.model
      if (r.effort) out.effort = r.effort
      out.onChange = r.onChange === true
    }
    const l = r.limits || {}
    out.limits = { perDay: l.perDay === undefined ? LIMIT_DEFAULTS.perDay : l.perDay, cooldownMinutes: l.cooldownMinutes === undefined ? LIMIT_DEFAULTS.cooldownMinutes : l.cooldownMinutes }
    for (const [k, v] of extraKeys(orig && orig.limits, LIMIT_KEYS)) out.limits[k] = v
    for (const [k, v] of extraKeys(orig, RULE_KEYS)) out[k] = v
    return out
  }

  return {
    RULES_FILE,
    V1_RULES_FILE,
    PLAYBOOKS_DIR,
    LEVELS,
    LEVEL_LABELS,
    refOf,
    MAX_RULES,
    MAX_RULES_BYTES,
    MAX_PLAYBOOK_BYTES,
    MAX_LIST,
    MAX_NEEDLE,
    MAX_CHECK,
    MAX_NAME,
    MAX_WHEN,
    MAX_SOURCES,
    MAX_QUESTION,
    MAX_PLUGIN_ID,
    RULE_ID,
    PLAYBOOK_NAME,
    PLUGIN_ID,
    ANY_SOURCE,
    LEVEL_LIST,
    MODEL_LIST,
    EFFORT_LIST,
    LIMITS,
    LIMIT_DEFAULTS,
    JEV_MIN_DEFAULT,
    ACTION_ID,
    ACT_REFUSED,
    SESSION_KEYS,
    MODE_LIST,
    MODE_DEFAULT,
    ALLOWED_ACTIONS,
    BASE_FILE,
    MAX_BASE_BYTES,
    hasAllowedActions,
    RULE_KEYS,
    JEV_KEYS,
    V1_KEYS,
    LIMIT_KEYS,
    HOURS_KEYS,
    inHours,
    hoursLabel,
    isObj,
    oneLine,
    quote,
    RuleError,
    checkRule,
    idOf,
    readRules,
    canonicalRule,
  }
})
