'use strict'
// The Autopilot panel's decisions, free of the DOM so node:test can check them (test/panel.test.js
// requires this file; the page loads it as a classic script before main.js, where these become
// globals). main.js only turns these models into elements, every string through textContent.
// (As bronos.inbox's rowlogic.js.)
//
// The rule format is lib/schema.js, the loader's own: the page loads it as a classic script before
// this file (the global `AutopilotSchema`), node:test requires it. So the form's inline errors are
// the loader's, and the host checks the same again before it writes.
//
// Two rule levels (design-v2 "Two rule levels"): the host sends `levels`, one per level (project,
// global) with its folder, entries, hash and playbook files. Every edit names its level; a rule's
// playbook is one of its own level's files, and an id is unique within its level only.
//
// 0.3.0: the form has a kind (a session with a playbook, or an act rule running one of the item's own
// actions with no session) and, for a session, a mode (investigate, or act with the playbook's "Allowed
// actions"); each level's base.md is shown with an edit entry beside its playbooks.

const S = typeof AutopilotSchema !== 'undefined' ? AutopilotSchema : require('../dist/lib/schema')

const p2 = (n) => String(n).padStart(2, '0')

/** "14:05" today, "11-02 14:05" another day (local time). */
function clockText(ms, now) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const n = new Date(now)
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  return d.toDateString() === n.toDateString() ? hm : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`
}

/** The switch row: its label and the line under it. */
function switchModel(state) {
  return state.on
    ? { on: true, label: 'Autopilot is on', hint: 'New or changed feed items that match a rule open a Claude tab that investigates them.' }
    : { on: false, label: 'Autopilot is off', hint: 'Nothing fires. Switch it on to start: items in the feeds then are the baseline, only new or changed ones fire.' }
}

/** Problem lines: the folders', then each source that is failing. */
function problemLines(state) {
  return [...(state.problems || []), ...(state.sources || []).filter((s) => s.error).map((s) => s.error)]
}

/**
 * Plain notes (a v1 rules.json that is not read): shown, never counted as problems. Built from the
 * levels, naming the level and not its path: the folder card above or below shows the path once.
 */
const hintLines = (state) => levelsOf(state).filter((l) => l.hint).map((l) => `${l.label} folder: an old v1 rules.json is here and is not read (v2 reads ${S.RULES_FILE}). Claude can port it with the autopilot-rules skill if you ask.`)

/** The levels the host sent, in check order (project, then global). */
const levelsOf = (state) => (Array.isArray(state.levels) ? state.levels : [])
/** One level's status, or an empty stand-in (no folder). */
function levelState(state, level) {
  return levelsOf(state).find((l) => l.level === level) || { level, label: level, folder: null, folderState: 'off', editable: false, entries: [], playbookFiles: [], hint: null }
}
/** The levels a new rule or playbook can go to: a folder whose rules file the host can rewrite. */
const writableLevels = (state) => levelsOf(state).filter((l) => l.editable)
/** The two folder rows of the top card: where each level's rules are, or why there are none. */
function folderRows(state) {
  return levelsOf(state).map((l) => ({
    level: l.level,
    label: `${l.label} rules folder`,
    hint: l.level === 'global' ? `${S.RULES_FILE} and playbooks/; rules for every project (the app setting "Global rules folder")` : `${S.RULES_FILE} and playbooks/; rules for this project only, checked first (the project setting "Project rules folder")`,
    path: l.folder || 'not set',
  }))
}

/** A log entry as a row: when, what, and the outcome (fired, skipped, the switch). */
function logModel(e, now) {
  const when = clockText(e.at, now)
  if (e.step === 'switch') return { kind: 'switch', when, title: String(e.note || ''), meta: '', outcome: '' }
  // A run event (lib/runs.js: a tab closed, a restored tab re-adopted, an early end): its note.
  if (e.note) return { kind: 'switch', when, title: String(e.title || e.itemId || ''), meta: `${e.rule} · ${e.source}`, outcome: String(e.note) }
  const score = typeof e.score === 'number' ? ` ${e.score.toFixed(2)}` : ''
  // An act rule's action that ran (0.3.0): a fire with what it did, "marked read: <title>".
  if (e.step === 'act' && e.outcome) return { kind: 'fired', when, title: String(e.title || e.itemId || ''), meta: `${e.rule} · ${e.source}`, outcome: `${e.outcome}${Array.isArray(e.also) && e.also.length ? `; also matched: ${e.also.join(', ')}` : ''}` }
  return {
    kind: e.tabId ? 'fired' : 'skipped',
    when,
    title: String(e.title || e.itemId || ''),
    meta: `${e.rule} · ${e.source}${e.itemId && e.itemId !== e.title ? ` · ${e.itemId}` : ''}`,
    // `also`: the rules below the item's rule that would have held too (first rule wins, they never ran).
    outcome: `${e.tabId ? `opened ${e.tabId} (${e.step}${score})` : `skipped (${e.step}${score}): ${e.skip || ''}`}${Array.isArray(e.also) && e.also.length ? `; also matched: ${e.also.join(', ')}` : ''}`,
  }
}

/** The dry run block: its heading line and one row per match. */
function dryModel(dry, now) {
  if (!dry) return null
  const n = (k, one) => `${k} ${one}${k === 1 ? '' : 's'}`
  const head = `${clockText(dry.at, now)}: ${n(dry.items, 'item')} from ${n(dry.sources, 'source')}, ${n(dry.rules, 'rule')}${dry.jev ? ', with Jev' : ', Jev not asked'}. No session was started.`
  const rows = (dry.results || []).map((r) => ({
    fire: r.fire,
    mark: r.fire === true ? 'would fire' : r.fire === null ? 'not decided' : 'would not fire',
    title: String(r.title || r.itemId || ''),
    meta: `${r.rule} · ${r.source} · matched ${(r.why || []).join(', ')}`,
    verdict: String(r.verdict || ''),
  }))
  return { head, off: !dry.on, rows, empty: rows.length ? '' : 'No rule matches a current item.', cut: dry.cut ? `${dry.cut} more not shown` : '' }
}

// ---- tabs and the folder ----

const TABS = [['rules', 'Rules'], ['running', 'Running'], ['playbooks', 'Playbooks'], ['log', 'Log']]

/** The tab bar: `[{ id, label, active }]`, the counts in the labels. */
function tabsModel(state, tab) {
  const sum = (k) => levelsOf(state).reduce((a, l) => a + (l[k] || []).length, 0)
  const n = { rules: sum('entries'), running: (state.running || []).length + (state.queued || []).length, playbooks: sum('playbookFiles'), log: (state.log || []).length }
  return TABS.map(([id, label]) => ({ id, label: n[id] ? `${label} (${n[id]})` : label, active: id === tab }))
}

/**
 * One level's missing-folder card (`lv`: a level of `state.levels`), or null when its folder and rules
 * file are there, or the level has no folder at all. "Add the example rules" also shows for a rules file
 * that is an empty list (the host refuses it over any rule). A v1 rules.json beside a missing new file
 * is the page's note above (hintLines): Create folder then makes an empty new file and leaves it alone.
 */
function folderModel(lv) {
  const fs = lv.folderState
  const empty = fs === 'ok' && lv.editable && !(lv.entries || []).length
  if (fs !== 'missing' && fs !== 'noRules' && !empty) return null
  // "Create folder" only when the folder itself is missing; with the folder there, the one thing a
  // missing file needs is the file (the same request: it makes what is absent and keeps the rest).
  const text = fs === 'missing'
    ? `The ${lv.level} rules folder does not exist yet.`
    : fs === 'noRules' ? `The ${lv.level} rules folder exists but has no ${S.RULES_FILE}.` : `The ${lv.level} ${S.RULES_FILE} has no rule yet.`
  const create = fs === 'missing' ? 'Create folder' : fs === 'noRules' ? 'Create empty rules file' : null
  return { level: lv.level, text, create, examples: true, hint: 'The example rules are copied switched off: change their names, spaces and sites to yours, try them with a dry run, then switch them on.' }
}

// ---- the rules list ----

/**
 * One row per entry of one level's rules file (`level`), valid or not, with what the row may offer and
 * the level's tag. An entry v1 left behind in the new file (`match`) is an invalid rule like any other:
 * its problem says so, and Edit opens the v2 form over it.
 */
function ruleRows(state, level) {
  const lv = levelState(state, level)
  const editable = Boolean(lv.editable)
  return (lv.entries || []).map((e) => {
    const withModel = S.isObj(e.raw) && (e.raw.model || e.raw.effort)
    const id = e.id !== null && e.id !== undefined ? e.id : null
    return {
      level,
      tag: level,
      index: e.index,
      id: e.id,
      name: id !== null ? id : `rule ${e.index + 1}`,
      ref: id !== null ? S.refOf(level, id) : `${level} rule ${e.index + 1}`,
      on: e.on !== false,
      ok: e.ok,
      summary: e.summary || '',
      // The host adds the "needs 0.11" warning itself once it knows (support "no"); "unknown" is the panel's to say.
      warnings: [...(e.warnings || []), ...(withModel && state.takeover === 'unknown' ? [supportNote('unknown')] : [])],
      problem: e.problem || '',
      outsiders: S.isObj(e.raw) && outsidersCan(e.raw.sources, state) ? OUTSIDERS_SHORT : '',
      canToggle: editable && e.schema === true,
      canEdit: editable && S.isObj(e.raw),
      canDelete: editable,
    }
  })
}

/**
 * The Running tab: one row per item's tab (rule, item, since, and flags), then the queue. The host
 * sends `running` (lib/runs.js list(): `pending` is the rev of an update waiting for the tab, null
 * when none), `queued`, `slots` and `maxRunning`.
 */
function runningModel(state, now) {
  const flags = (r) => [
    r.pending !== null && r.pending !== undefined ? 'update waiting' : '',
    r.takenOver ? 'taken over: you typed in it' : '',
    r.stopped ? 'stopped' : '',
  ].filter(Boolean)
  const rows = (state.running || []).map((r) => ({
    title: str(r.itemId),
    meta: `${r.rule} · ${r.source}`,
    status: str(r.status),
    since: r.openedAt ? `since ${clockText(r.openedAt, now)}` : '',
    flags: flags(r),
    updates: r.deliveries ? `${r.deliveries} update${r.deliveries === 1 ? '' : 's'} sent` : '',
  }))
  const queue = (state.queued || []).map((q) => ({ title: str(q.itemId), meta: str(q.source), since: q.at ? `queued ${clockText(q.at, now)}` : '' }))
  const slots = typeof state.slots === 'number' && typeof state.maxRunning === 'number' ? `${state.slots} of ${state.maxRunning} slots in use` : ''
  return { slots, rows, queue, empty: rows.length || queue.length ? '' : 'No Autopilot session is running.' }
}

const OUTSIDERS_SHORT = 'outsiders can trigger this'

const confirmText = (kind, name) => `Delete ${kind} ${name}?`

// ---- the rule form ----

// Not a name a playbook can have (PLAYBOOK_NAME has no "*").
const NEW_PLAYBOOK = '*new'

// The condition format is lib/conditions.js (Inbox's), a global in the page like the schema.
const COND = typeof AutopilotConditions !== 'undefined' ? AutopilotConditions : require('../dist/lib/conditions')

const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : typeof v === 'string' && v ? [v] : [])
const str = (v) => (v === undefined || v === null ? '' : String(v))
const jsonCopy = (v) => JSON.parse(JSON.stringify(v))

// ---- the condition editor (copied from bronos.inbox settings/logic.js, adapted to a plain list) ----
// The page edits a plain array of `{ field, op, value }`; every edit returns a new array. Nothing
// here promises validity: the loader's own check (schema.js, through formErrors) speaks, so a
// half-typed value is an inline error and never a silent change.

const COND_OP_LABELS = Object.freeze({
  is: 'is', isNot: 'is not', in: 'is one of', notIn: 'is none of', contains: 'contains', notContains: 'does not contain', startsWith: 'starts with',
  endsWith: 'ends with', has: 'has', hasNot: 'has not', hasPrefix: 'has one starting with', newerThan: 'newer than (minutes)', olderThan: 'older than (minutes)',
})

/** The table the editor offers, from the condition module: one table, no copy to drift. */
function condTable() {
  return { fields: COND.FIELDS, kinds: COND.KINDS, to: COND.TO, categories: COND.CATEGORIES, caps: { value: COND.MAX_VALUE, minutes: COND.MAX_MINUTES, in: COND.MAX_IN } }
}

/** The ops that take a list of values (one per line). */
const condIsList = (op) => op === 'in' || op === 'notIn'

/** The value a field's kind starts with. */
function condDefaultValue(kind) {
  switch (kind) {
    case 'kind': return 'chat'
    case 'to': return 'direct'
    case 'category': return 'done'
    case 'bool':
    case 'read': return true
    case 'minutes': return 60
    default: return ''
  }
}

/** A new condition: the table's first field with its first op (Inbox starts at sourceKind). */
function condDefault(table) {
  const fields = Object.keys(table.fields)
  const field = fields.includes('sourceKind') ? 'sourceKind' : fields[0]
  const spec = table.fields[field]
  return { field, op: spec.ops[0], value: condDefaultValue(spec.value) }
}

/** A value fitted to the op: `in` takes a list, every other op one value. */
function condFit(value, op, kind) {
  if (condIsList(op)) {
    if (Array.isArray(value)) return value
    return value === '' || value === undefined || value === null ? [] : [value]
  }
  if (Array.isArray(value)) return value.length ? value[0] : condDefaultValue(kind)
  return value
}

const condAdd = (when, table) => [...when, condDefault(table)]
const condRemove = (when, i) => when.filter((_, j) => j !== i)

/**
 * One condition changed: `field`, `op` or `value`. A new field keeps the op when the field takes it
 * (else its first op) and the value when its kind is the same (else the kind's default). A field
 * the table does not know (a hand-written rule) is replaced by the first pick from the table.
 */
function condSet(when, i, patch, table) {
  if (!when[i]) return when
  const next = jsonCopy(when)
  const c = next[i]
  const before = table.fields[c.field]
  if ('field' in patch && Object.hasOwn(table.fields, patch.field)) {
    const spec = table.fields[patch.field]
    c.field = patch.field
    if (!spec.ops.includes(c.op)) c.op = spec.ops[0]
    if (!before || before.value !== spec.value) c.value = condDefaultValue(spec.value)
  }
  const spec = table.fields[c.field]
  if ('op' in patch && spec && spec.ops.includes(patch.op)) c.op = patch.op
  if ('value' in patch) c.value = patch.value
  if (spec) c.value = condFit(c.value, c.op, spec.value)
  return next
}

/** A condition's value as its input shows it: a list one per line, a boolean or null as its word. */
function condValueText(value) {
  if (Array.isArray(value)) return value.map(String).join('\n')
  if (value === null) return 'null'
  return String(value)
}

/**
 * An input's text as a condition's value of `kind`: a list (`in`) one value per line, blank lines
 * dropped; `minutes` a whole number when it is one (anything else stays text, and the loader's check
 * refuses it with the reason); `bool` / `read` from their words.
 */
function condParse(text, kind, op) {
  const one = (s) => {
    if (kind === 'minutes') return /^\s*\d+\s*$/.test(s) ? Number(s) : s
    if (kind === 'bool') return s === 'true'
    if (kind === 'read') return s === 'null' ? null : s === 'true'
    return s
  }
  if (condIsList(op)) return str(text).split('\n').map((s) => s.trim()).filter(Boolean).map(one)
  return one(str(text))
}

/** What a condition's value control is: `select`, `checks` (an `in` over a fixed list), `lines`, `number` or `text`. */
function condControl(cond, table) {
  const spec = table.fields[cond.field]
  const kind = spec ? spec.value : 'text'
  const fixed = kind === 'kind' ? table.kinds : kind === 'to' ? table.to : kind === 'category' ? table.categories : null
  if (fixed) return condIsList(cond.op) ? { type: 'checks', options: fixed } : { type: 'select', options: fixed }
  if (kind === 'bool') return { type: 'select', options: ['true', 'false'] }
  if (kind === 'read') return { type: 'select', options: ['true', 'false', 'null'] }
  if (kind === 'minutes') return { type: 'number', min: 1, max: table.caps.minutes }
  if (condIsList(cond.op)) return { type: 'lines', max: table.caps.value }
  return { type: 'text', max: table.caps.value }
}

/** The field choices, with the rule's own field added when the table does not have it. */
function condFieldOptions(cond, table) {
  const out = Object.keys(table.fields).map((x) => ({ value: x, label: x }))
  if (cond && !Object.hasOwn(table.fields, cond.field)) out.unshift({ value: str(cond.field), label: `${str(cond.field) || '(none)'} (not a field)` })
  return out
}

/** The op choices of a field, with their words (none for a field the table does not know). */
function condOpOptions(field, table) {
  const spec = table.fields[field]
  return (spec ? spec.ops : []).map((op) => ({ value: op, label: COND_OP_LABELS[op] || op }))
}

// ---- sources, and who can reach the rule ----

/**
 * The sources picker: every provider `useAll` sees now (id and label), then the rule's own ids that
 * no provider has, kept and marked, so editing never drops an id silently (a plugin that is off now
 * may be back tomorrow).
 */
function sourceChoices(state, ids) {
  const out = (state.sources || []).map((s) => ({ id: s.pluginId, label: s.label && s.label !== s.pluginId ? `${s.label} (${s.pluginId})` : s.pluginId, known: true }))
  for (const id of ids) if (!out.some((o) => o.id === id)) out.push({ id, label: `${id} (no such source here)`, known: false })
  return out
}

/** The ids with `id` on or off (order: as picked). */
const sourceToggle = (ids, id, on) => (on ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((x) => x !== id))

const OUTSIDERS = 'Outsiders can trigger this rule: anyone can send you mail that matches, and the session reads what they wrote. Keep the playbook narrow and name the places it may check itself.'
// An act rule reads nothing with a model, but a stranger can still make a mail match and have the action
// run on it (a mail marked read before the person saw it): the conditions are the only gate.
const OUTSIDERS_ACT = 'Outsiders can trigger this rule: anyone can send you mail that matches, and the action runs on it with nobody looking (a mail marked read is one you may never see). Make the conditions name the sender.'
/** The note under the sources: OUTSIDERS for a session rule, OUTSIDERS_ACT for an act rule, '' when outsiders cannot trigger it. */
const outsidersNote = (f, state) => (outsidersCan(f.sourceAny ? [S.ANY_SOURCE] : f.sources, state) ? (f.kind === 'act' ? OUTSIDERS_ACT : OUTSIDERS) : '')

/**
 * Whether people outside the person can put an item in front of this rule: `["*"]` (any source
 * includes mail) or a mail source. A source's kind comes from the feed now running; one that is not
 * running is judged by its id (a "mail" in it), the safe side of a guess.
 */
function outsidersCan(sourceIds, state) {
  const ids = strList(sourceIds)
  if (ids.includes(S.ANY_SOURCE)) return true
  const kinds = new Map((state.sources || []).map((s) => [s.pluginId, s.kind]))
  return ids.some((id) => (kinds.has(id) ? kinds.get(id) === 'mail' : /mail/i.test(id)))
}

/**
 * The playbook dropdown for a rule of `level`: every playbook file of that level the loader can use (a
 * rule's playbook resolves in its own level), the rule's own when it is missing, then "New playbook…".
 */
function playbookOptions(state, current, level) {
  const out = (levelState(state, level).playbookFiles || []).filter((p) => !p.invalid).map((p) => ({ value: p.name, label: p.name }))
  if (current && current !== NEW_PLAYBOOK && !out.some((o) => o.value === current)) out.push({ value: current, label: `${current} (missing)` })
  out.push({ value: NEW_PLAYBOOK, label: 'New playbook…' })
  return out
}

/** Model or effort choices: "Default" first (the key is left out), then Claude Code's aliases, then the rule's own odd value. */
function choiceOptions(list, current) {
  const out = [{ value: '', label: 'Default' }, ...list.map((v) => ({ value: v, label: v }))]
  if (current && !list.includes(current)) out.push({ value: current, label: `${current} (not a known value)` })
  return out
}

/**
 * The note under model and effort. 'yes': nothing. 'no': an app before 0.11 drops them. 'unknown': the
 * app tells only through a Claude tab (SessionInfo.typed), so until one exists it cannot be said.
 */
function supportNote(takeover) {
  if (takeover === 'no') return 'needs cc-cockpit 0.11: this app ignores them and starts the session with your default'
  if (takeover === 'unknown') return 'needs cc-cockpit 0.11; unknown until a Claude tab exists, then this says whether this app has it'
  return ''
}

// ---- kind and mode (0.3.0) ----

/** The well-known action ids the act field offers (a source may add its own; the field takes any id). */
const ACT_CHOICES = Object.freeze(['markRead', 'markUnread', 'done'])

const MODE_WARN = 'Act mode: the session may carry out the actions its playbook lists under "Allowed actions", on this item, with nobody watching. List each action with its exact target; Claude Code\'s own permission settings still apply in the tab.'
const MODE_WARN_OUTSIDERS = 'Act mode on a rule outsiders can trigger: a stranger\'s message starts a session that may carry out the playbook\'s actions. The frame tells it never to take an action or a target from the item, but keep the Allowed actions few and harmless, or use Investigate here.'

/**
 * The warning under the mode choice: none for investigate or an act rule (no session); act mode warns,
 * and more strongly when outsiders can trigger the rule (outsidersCan, the same test as the row flag).
 */
function modeWarning(f, state) {
  if (f.kind === 'act' || f.mode !== 'act') return ''
  return outsidersCan(f.sourceAny ? [S.ANY_SOURCE] : f.sources, state) ? MODE_WARN_OUTSIDERS : MODE_WARN
}

/**
 * The form's model from a raw entry (an edit; any shape, an invalid one included) or null (a new
 * rule: off, so it fires only once the person has tried it and switched it on), for a rule of `level`
 * (an edit keeps its level; a new rule's level is picked in the form). Every field is a string, a
 * boolean or a list the inputs edit in place.
 */
function formFromRaw(raw, state, level) {
  const r = S.isObj(raw) ? raw : {}
  const l = S.isObj(r.limits) ? r.limits : {}
  const h = S.isObj(r.hours) ? r.hours : null
  const j = S.isObj(r.jev) ? r.jev : null
  const ids = strList(r.sources)
  const pbs = (state && levelState(state, level).playbookFiles) || []
  const firstPb = pbs.find((p) => !p.invalid)
  // An act rule: `act` and no playbook (an entry with both is judged a session rule, and its error shows).
  const isAct = r.act !== undefined && r.playbook === undefined
  return {
    level,
    kind: isAct ? 'act' : 'session',
    act: isAct ? str(r.act) : '',
    mode: r.mode === undefined ? S.MODE_DEFAULT : str(r.mode),
    id: str(r.id),
    name: str(r.name),
    enabled: raw ? r.enabled !== false : false,
    sourceAny: ids.includes(S.ANY_SOURCE),
    sources: ids.filter((x) => x !== S.ANY_SOURCE),
    // A stray non-object entry becomes an empty condition, so the loader's check flags it; dropping it would pass silently.
    when: Array.isArray(r.when) ? r.when.map((c) => (S.isObj(c) ? jsonCopy(c) : { field: '', op: '', value: '' })) : [],
    // An existing rule with nothing to test was confirmed when it was written; a new one asks.
    confirmAll: Boolean(raw),
    jevOn: Boolean(j),
    question: j ? str(j.question) : '',
    min: j && j.min !== undefined ? str(j.min) : String(S.JEV_MIN_DEFAULT),
    // "Any time" unless the rule has hours; the times start at a night window for when it is switched to a window.
    hoursMode: h ? 'set' : 'any',
    hoursFrom: h ? str(h.from) : '22:00',
    hoursTo: h ? str(h.to) : '07:00',
    // An act rule has none: the level's first one is there if the person switches it to a session.
    playbook: raw && !isAct ? str(r.playbook) : firstPb ? firstPb.name : NEW_PLAYBOOK,
    newPlaybook: '',
    check: str(r.check),
    model: str(r.model),
    effort: str(r.effort),
    onChange: r.onChange === true,
    // A limit the rule leaves out shows its kind's default (an act rule: 100 a day, no cooldown).
    perDay: l.perDay === undefined ? String(S.limitDefaults(isAct).perDay) : str(l.perDay),
    cooldownMinutes: l.cooldownMinutes === undefined ? String(S.limitDefaults(isAct).cooldownMinutes) : str(l.cooldownMinutes),
  }
}

/**
 * The form's limits after the kind changed from `from` to `f.kind`: a limit still at the old kind's
 * default (or empty) takes the new kind's, a number the person typed stays. Without it a session rule
 * switched to an action kept a 30-minute cooldown, the very thing an act rule's defaults are there to avoid.
 */
function kindLimits(f, from) {
  const was = S.limitDefaults(from === 'act')
  const now = S.limitDefaults(f.kind === 'act')
  const out = {}
  for (const k of ['perDay', 'cooldownMinutes']) {
    const t = String(f[k]).trim()
    out[k] = t === '' || t === String(was[k]) ? String(now[k]) : f[k]
  }
  return out
}

/** A number field: a number when it reads as one (so the loader's range check speaks), else the text (its type check speaks); empty is the default. */
function numOf(v) {
  const t = String(v).trim()
  // Empty: the default (canonicalRule fills it in).
  if (!t) return undefined
  return /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : t
}

/**
 * The raw rule the form stands for, in the order it is written (schema.js canonicalRule). An act rule
 * keeps none of the session fields the form still holds (switching the kind back keeps them typed).
 */
function formToRule(f) {
  const common = {
    id: f.id.trim(),
    name: f.name,
    enabled: f.enabled,
    sources: f.sourceAny ? [S.ANY_SOURCE] : f.sources,
    when: f.when,
    ...(f.jevOn ? { jev: { question: f.question, min: numOf(f.min) } } : {}),
    ...(f.hoursMode === 'set' ? { hours: { from: f.hoursFrom, to: f.hoursTo } } : {}),
  }
  const limits = { perDay: numOf(f.perDay), cooldownMinutes: numOf(f.cooldownMinutes) }
  // An empty action stays a key, so the loader's own "act must be an action id" is the error shown.
  if (f.kind === 'act') return S.canonicalRule({ ...common, act: str(f.act).trim() || ' ', limits }, null)
  const rule = {
    ...common,
    playbook: f.playbook === NEW_PLAYBOOK ? f.newPlaybook.trim() : f.playbook,
    mode: f.mode,
    check: f.check,
    model: f.model,
    effort: f.effort,
    onChange: f.onChange,
    limits,
  }
  return S.canonicalRule(rule, null)
}

const CONFIRM_ALL = 'no conditions and no Jev question: this rule fires on every new item from its sources. Tick the box to confirm, or add a condition'

/**
 * The form's errors, `{ field: message }`, the loader's own (schema.js checkRule) plus what the file
 * of the form's level decides: the id unique among every other entry of that level (the other level
 * may have the same id: it is another rule there), a new playbook's name not taken in that level, a
 * level with a writable folder, and the person's confirmation of a rule that tests nothing.
 * `editIndex` is the entry being edited, or null for a new rule. Empty: the form may be saved.
 */
function formErrors(f, state, editIndex) {
  const rule = formToRule(f)
  const lv = levelState(state, f.level)
  const out = {}
  if (!lv.editable) out.level = `the ${f.level} rules file cannot be written here: ${lv.folder ? 'it is not a JSON list: fix it by hand' : 'no folder is set for it'}`
  for (const e of S.checkRule(rule).errors) if (!out[e.field]) out[e.field] = e.message
  if (!out.id && (lv.entries || []).some((e) => e.index !== editIndex && e.id === rule.id)) out.id = `id ${S.quote(rule.id)} is used by another ${f.level} rule`
  if (!out.when && !f.when.length && !f.jevOn && !f.confirmAll) out.when = CONFIRM_ALL
  if (f.kind !== 'act' && f.playbook === NEW_PLAYBOOK) {
    if (!f.newPlaybook.trim()) out.playbook = 'name the new playbook'
    else if ((lv.playbookFiles || []).some((p) => p.name === rule.playbook)) out.playbook = `a playbook ${rule.playbook} exists: pick it in the list`
  }
  return out
}

// ---- playbooks ----

/** One row per playbook file of `level`: who uses it (that level's rules), whether it can be edited or deleted. */
function playbookRows(state, level) {
  return (levelState(state, level).playbookFiles || []).map((p) => ({
    level,
    name: p.name,
    usedBy: p.usedBy || [],
    used: p.usedBy && p.usedBy.length ? `used by: ${p.usedBy.join(', ')}` : 'not used by a rule',
    size: `${Math.max(1, Math.round((p.size || 0) / 1024))} KiB`,
    note: p.link ? 'a symbolic link: edit it by hand' : p.invalid ? 'not a name a rule can use (letters, digits, "_" or "-"): rename it' : '',
    canEdit: !p.link && !p.invalid,
    canDelete: !p.link && !p.invalid,
  }))
}

/** Why a used playbook cannot be deleted (the host refuses it too). */
const deleteBlocked = (row) => (row.usedBy.length ? `${row.name} is used by: ${row.usedBy.join(', ')}. Change or delete those rules first.` : '')

const utf8Length = (s) => new TextEncoder().encode(s).length

/** The playbook editor's errors, `{ name?, body? }`: the loader's name rule, a new name not taken in its level, the size cap. */
function playbookErrors(p, state) {
  const out = {}
  if (!S.PLAYBOOK_NAME.test(p.name)) out.name = 'letters, digits, "_" or "-", starting with a letter or digit (no dot, no slash), at most 64'
  else if (p.isNew && (levelState(state, p.level).playbookFiles || []).some((x) => x.name === p.name)) out.name = `${p.name} exists: edit that one`
  if (!p.body.trim()) out.body = 'the playbook is empty'
  else if (utf8Length(p.body) > S.MAX_PLAYBOOK_BYTES) out.body = `over ${S.MAX_PLAYBOOK_BYTES / 1024} KiB`
  return out
}

// ---- base.md (0.3.0) ----

/**
 * One row per level with a folder: whether its base.md is in use (and its size), its problem, whether
 * the editor may open it (a level whose folder exists or can be made, as for playbooks).
 */
function baseRows(state) {
  return levelsOf(state).filter((l) => l.folder).map((l) => ({
    level: l.level,
    label: `${l.label} ${S.BASE_FILE}`,
    inUse: Boolean(l.base),
    text: l.baseProblem ? 'cannot be used: no session opens until it is fixed' : l.base ? `in use: every session prompt carries it (${sizeLabel(l.base.size)})` : 'not set: sessions get no standing instructions from this level',
    problem: l.baseProblem || '',
    canEdit: l.folderState !== 'off',
  }))
}

/** "512 bytes" under 1 KiB, else "3 KiB" (a short base.md reads as "1 KiB" otherwise). */
const sizeLabel = (n) => (n < 1024 ? `${n || 0} bytes` : `${Math.round(n / 1024)} KiB`)

/** The base.md editor's error (`{ body? }`): only the size cap; an empty text is allowed (it removes the file). */
function baseErrors(body) {
  return utf8Length(str(body)) > S.MAX_BASE_BYTES ? { body: `over ${S.MAX_BASE_BYTES / 1024} KiB` } : {}
}
const baseSizeText = (body) => `${(utf8Length(str(body)) / 1024).toFixed(1)} of ${S.MAX_BASE_BYTES / 1024} KiB`

/** "3.2 of 64 KiB" under the editor. */
const sizeText = (body) => `${(utf8Length(body) / 1024).toFixed(1)} of ${S.MAX_PLAYBOOK_BYTES / 1024} KiB`

/** A new playbook's first text in the editor. */
const playbookTemplate = () => '# What to check\n\nWhat the session checks, how, and what it reports. Name the places it may check itself (your hosts, projects), so it never takes one from the item.\n'

/**
 * Holds redraws while a mouse button is down (bronos.inbox rowlogic.js): a redraw between press and
 * release replaces the pressed element and the click is lost. `request()` draws at once when no
 * button is down, else once after the release and the click it makes. The open form is the other
 * half of the gate: main.js does not redraw at all while a form is open.
 */
function createRenderGate(draw, defer = (fn) => setTimeout(fn, 0)) {
  let down = false
  let pending = false
  return {
    down() {
      down = true
    },
    up() {
      defer(() => {
        down = false
        if (pending) {
          pending = false
          draw()
        }
      })
    },
    request() {
      if (down) pending = true
      else draw()
    },
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    clockText, switchModel, problemLines, hintLines, levelsOf, levelState, writableLevels, folderRows, logModel, dryModel,
    TABS, tabsModel, folderModel, ruleRows, runningModel, confirmText, OUTSIDERS, OUTSIDERS_ACT, outsidersNote, OUTSIDERS_SHORT,
    NEW_PLAYBOOK, playbookOptions, choiceOptions, supportNote, sourceChoices, sourceToggle, outsidersCan, formFromRaw, kindLimits, formToRule, formErrors, numOf,
    condTable, condDefault, condAdd, condRemove, condSet, condValueText, condParse, condControl, condFieldOptions, condOpOptions, COND_OP_LABELS,
    playbookRows, deleteBlocked, playbookErrors, sizeText, playbookTemplate, createRenderGate,
    ACT_CHOICES, MODE_WARN, MODE_WARN_OUTSIDERS, modeWarning, baseRows, baseErrors, baseSizeText,
  }
}
