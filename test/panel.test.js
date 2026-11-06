'use strict'
// The panel's pure parts (viewlogic.js) and a guard on main.js: text only ever goes in through
// textContent. Local time is Berlin so the clocks are checkable.
process.env.TZ = 'Europe/Berlin'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const V = require('../panels/viewlogic')

const NOW = Date.parse('2026-11-03T13:42:00+01:00')

test('clock: time today, date and time before', () => {
  assert.equal(V.clockText(NOW - 60000, NOW), '13:41')
  assert.equal(V.clockText(NOW - 24 * 3600000, NOW), '11-02 13:42')
  assert.equal(V.clockText(null, NOW), '')
})

test('the switch row and the problem lines (folder problems, then failing sources)', () => {
  assert.equal(V.switchModel({ on: false }).label, 'Autopilot is off')
  assert.match(V.switchModel({ on: true }).hint, /open a Claude tab/)
  assert.deepEqual(V.problemLines({ problems: ['autopilot-rules.json: not found'], sources: [{ label: 'Jira' }, { label: 'Mail', error: 'Mail: signed out' }] }), ['autopilot-rules.json: not found', 'Mail: signed out'])
})

test('log rows: fired, skipped (with the step and score), the switch', () => {
  const fired = V.logModel({ at: NOW, rule: 'down', source: 'bronos.jira', itemId: 'SUP-1', title: 'Site down', step: 'jev', score: 0.9, tabId: 'tab-2' }, NOW)
  assert.deepEqual(fired, { kind: 'fired', when: '13:42', title: 'Site down', meta: 'down · bronos.jira · SUP-1', outcome: 'opened tab-2 (jev 0.90)' })
  const skip = V.logModel({ at: NOW, rule: 'down', source: 'bronos.jira', itemId: 'SUP-1', title: 'Site down', step: 'limit', skip: 'cooldown' }, NOW)
  assert.equal(skip.kind, 'skipped')
  assert.equal(skip.outcome, 'skipped (limit): cooldown')
  assert.deepEqual(V.logModel({ at: NOW, step: 'switch', note: 'Autopilot switched on' }, NOW), { kind: 'switch', when: '13:42', title: 'Autopilot switched on', meta: '', outcome: '' })
})

test('the dry run block: heading, rows marked would fire / not decided / would not fire', () => {
  assert.equal(V.dryModel(null, NOW), null)
  const m = V.dryModel({ at: NOW, on: false, jev: false, rules: 2, sources: 1, items: 1, cut: 0, results: [
    { rule: 'a', source: 'p.x', itemId: 'i', title: 'T', why: ['text "t"'], fire: true, verdict: 'it would open a session' },
    { rule: 'b', source: 'p.x', itemId: 'i', title: 'T', why: [], fire: null, verdict: 'jev not asked' },
    { rule: 'c', source: 'p.x', itemId: 'i', title: 'T', why: [], fire: false, verdict: 'the rule is off' },
  ] }, NOW)
  assert.equal(m.head, '13:42: 1 item from 1 source, 2 rules, Jev not asked. No session was started.')
  assert.equal(m.off, true)
  assert.deepEqual(m.rows.map((r) => r.mark), ['would fire', 'not decided', 'would not fire'])
  assert.equal(m.rows[0].meta, 'a · p.x · matched text "t"')
  assert.equal(V.dryModel({ at: NOW, on: true, rules: 1, sources: 0, items: 0, results: [] }, NOW).empty, 'No rule matches a current item.')
})

test('main.js builds every element with textContent: no markup sinks at all', () => {
  for (const f of ['main.js', 'viewlogic.js', '../dist/lib/schema.js', '../dist/lib/conditions.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'panels', f), 'utf8')
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f)
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'panels', 'main.html'), 'utf8')
  // The CSP allows no inline script: every script has a src.
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /\bsrc=/)
  // The rule format loads before the view logic that uses it, and it is the loader's own file.
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(srcs, ['/__sdk/panel.js', '../dist/lib/conditions.js', '../dist/lib/schema.js', 'viewlogic.js', 'main.js'])
  assert.equal(require.resolve('../dist/lib/schema'), path.join(__dirname, '..', 'panels', '../dist/lib/schema.js'))
})

// ---- the editor ----

const S = require('../dist/lib/schema')
const entry = (index, raw, o = {}) => ({ index, id: S.idOf(raw), raw, ok: true, schema: true, on: raw.enabled !== false, summary: 's', warnings: [], problem: null, ...o })
// The project level the editor tests work on, and an empty global level (no folder set).
const LV = {
  level: 'project',
  label: 'Project',
  folder: '/work/project/.autopilot',
  folderState: 'ok',
  editable: true,
  rulesHash: 'h1',
  entries: [entry(0, { id: 'a', sources: ['bronos.jira'], when: [{ field: 'title', op: 'contains', value: 'x' }], playbook: 'check' }), entry(1, { id: 'bad id' }, { ok: false, schema: false, problem: 'id must be ...' }), entry(2, 42, { id: null, ok: false, schema: false, problem: 'a rule must be an object' }), entry(3, { id: 'old', match: { text: ['x'] }, condition: 'c', playbook: 'check' }, { ok: false, schema: false, problem: 'sources is missing: ... ("match" is a v1 key; ...)' })],
  playbookFiles: [{ name: 'check', size: 2048, usedBy: ['a'] }, { name: 'spare', size: 10, usedBy: [] }, { name: 'a.b', size: 1, usedBy: [], invalid: true }, { name: 'ln', size: 0, usedBy: [], link: true }],
  hint: null,
}
const GL = { level: 'global', label: 'Global', folder: null, folderState: 'off', editable: false, rulesHash: null, entries: [], playbookFiles: [], hint: null }
const ST = {
  levels: [LV, GL],
  sources: [{ pluginId: 'bronos.jira', label: 'Jira', kind: 'issues' }, { pluginId: 'bronos.gmail', label: 'Mail', kind: 'mail' }],
  running: [],
  queued: [],
  takeover: 'yes',
  log: [],
  jev: false,
}
/** ST with the project level changed. */
const withLv = (o, top = {}) => ({ ...ST, ...top, levels: [{ ...LV, ...o }, GL] })

test('tabs and the missing-folder card', () => {
  assert.deepEqual(V.tabsModel(ST, 'playbooks').map((t) => [t.id, t.label, t.active]), [['rules', 'Rules (4)', false], ['running', 'Running', false], ['playbooks', 'Playbooks (4)', true], ['log', 'Log', false]])
  assert.equal(V.folderModel(LV), null)
  assert.equal(V.folderModel(GL), null, 'a level with no folder set has no card')
  const missing = V.folderModel({ ...LV, folderState: 'missing', entries: [], editable: false })
  assert.match(missing.text, /does not exist yet/)
  assert.doesNotMatch(missing.text, /\/work\/project/, 'the path is in the folder row, not repeated')
  assert.deepEqual([missing.create, missing.examples], ['Create folder', true])
  // The folder is there and only the file is missing: no "Create folder", the text says so.
  const noRules = V.folderModel({ ...LV, folderState: 'noRules', entries: [], editable: false })
  assert.match(noRules.text, /exists but has no autopilot-rules.json/)
  assert.doesNotMatch(noRules.text, /\/work\/project/)
  assert.notEqual(noRules.create, 'Create folder')
  assert.equal(noRules.create, 'Create empty rules file')
  assert.equal(noRules.examples, true)
  const empty = V.folderModel({ ...LV, entries: [] })
  assert.deepEqual([empty.create, empty.examples], [null, true])
  assert.equal(V.folderModel({ ...LV, folderState: 'ok', editable: false, entries: [] }), null, 'a broken file offers nothing to write over it')
})

test('rule rows: every entry, invalid ones as problems with their raw id; a v1 entry is just invalid; what each may offer', () => {
  const rows = V.ruleRows(ST, 'project')
  assert.deepEqual(rows.map((r) => [r.name, r.ok, r.canToggle, r.canEdit, r.canDelete]), [['a', true, true, true, true], ['bad id', false, false, true, true], ['rule 3', false, false, false, true], ['old', false, false, true, true]])
  assert.deepEqual(rows.map((r) => [r.tag, r.ref]), [['project', 'project:a'], ['project', 'project:bad id'], ['project', 'project rule 3'], ['project', 'project:old']])
  assert.equal(rows[1].problem, 'id must be ...')
  assert.match(rows[3].problem, /"match" is a v1 key/)
  assert.equal(rows[3].v1, undefined)
  assert.ok(V.ruleRows(withLv({ editable: false }), 'project').every((r) => !r.canToggle && !r.canEdit && !r.canDelete))
  assert.deepEqual(V.ruleRows(ST, 'global'), [])
  assert.equal(V.confirmText('rule', 'a'), 'Delete rule a?')
})

test('two levels: folder rows, the writable levels, per-level rows, ids, playbooks and the v1 note', () => {
  const G = { ...GL, folder: '~/.config/cc-cockpit-autopilot', folderState: 'ok', editable: true, rulesHash: 'g1', entries: [entry(0, { id: 'a', sources: ['*'], playbook: 'global-only' })], playbookFiles: [{ name: 'global-only', size: 5, usedBy: ['a'] }] }
  const both = { ...ST, levels: [LV, { ...G, hint: 'an old v1 rules.json is in this folder' }], hints: ['Global folder: x'] }
  assert.deepEqual(V.folderRows(both).map((r) => [r.level, r.label, r.path]), [['project', 'Project rules folder', '/work/project/.autopilot'], ['global', 'Global rules folder', '~/.config/cc-cockpit-autopilot']])
  assert.equal(V.folderRows(ST)[1].path, 'not set')
  assert.deepEqual(V.writableLevels(both).map((l) => l.level), ['project', 'global'])
  assert.deepEqual(V.writableLevels(ST).map((l) => l.level), ['project'], 'a new rule can only go where a folder is')
  // The note names the level, not the path (the folder row shows it once).
  assert.deepEqual(V.hintLines(both), ['Global folder: an old v1 rules.json is here and is not read (v2 reads autopilot-rules.json). Claude can port it with the autopilot-rules skill if you ask.'])
  assert.deepEqual(V.hintLines(ST), [])
  assert.deepEqual(V.problemLines(both), [], 'a note is never a problem')
  assert.deepEqual(V.tabsModel(both, 'rules')[0].label, 'Rules (5)', 'the counts add both levels')
  assert.deepEqual(V.ruleRows(both, 'global').map((r) => [r.tag, r.ref, r.canEdit]), [['global', 'global:a', true]])
  // Ids are unique per level: "a" is free for a new global rule's sibling only at the other level.
  const pForm = { ...V.formFromRaw(null, both, 'project'), id: 'a', sources: ['bronos.jira'], when: [{ field: 'title', op: 'contains', value: 'x' }] }
  assert.match(V.formErrors(pForm, both, null).id, /used by another project rule/)
  const gForm = { ...V.formFromRaw(null, both, 'global'), id: 'b', sources: ['bronos.jira'], when: [{ field: 'title', op: 'contains', value: 'x' }] }
  assert.equal(gForm.level, 'global')
  assert.equal(gForm.playbook, 'global-only', 'a new rule picks a playbook of its own level')
  assert.deepEqual(V.formErrors(gForm, both, null), {})
  assert.deepEqual(V.formErrors({ ...gForm, id: 'a' }, both, 0), {}, 'its own id when editing it')
  assert.deepEqual(V.playbookOptions(both, 'check', 'global').map((o) => o.label), ['global-only', 'check (missing)', 'New playbook…'], "the project's playbook is not the global rule's")
  assert.match(V.formErrors(gForm, ST, null).level, /global rules file cannot be written here: no folder is set/)
  assert.match(V.playbookErrors({ level: 'global', name: 'global-only', body: 'x', isNew: true }, both).name, /exists/)
  assert.deepEqual(V.playbookErrors({ level: 'project', name: 'global-only', body: 'x', isNew: true }, both), {})
  assert.deepEqual(V.playbookRows(both, 'global').map((r) => [r.level, r.name, r.used]), [['global', 'global-only', 'used by: a']])
})

test('outsiders can trigger it: any source or a mail source (by kind; by id when the feed is not running)', () => {
  assert.equal(V.outsidersCan(['*'], ST), true)
  assert.equal(V.outsidersCan(['bronos.gmail'], ST), true)
  assert.equal(V.outsidersCan(['bronos.jira'], ST), false)
  assert.equal(V.outsidersCan(['bronos.chat', 'bronos.gmail'], ST), true)
  assert.equal(V.outsidersCan(['example.mailer'], ST), true, 'not running: the id is the only hint')
  assert.equal(V.outsidersCan(['example.rss'], ST), false)
  const rows = V.ruleRows(withLv({ entries: [entry(0, { id: 'a', sources: ['bronos.gmail'], playbook: 'check' }), entry(1, { id: 'b', sources: ['bronos.jira'], playbook: 'check' })] }), 'project')
  assert.deepEqual(rows.map((r) => r.outsiders), [V.OUTSIDERS_SHORT, ''])
})

test('the model and effort note: 0.11 needed (no), unknown until a Claude tab exists, and the row warning', () => {
  assert.equal(V.supportNote('yes'), '')
  assert.match(V.supportNote('no'), /needs cc-cockpit 0.11: this app ignores them/)
  assert.match(V.supportNote('unknown'), /unknown until a Claude tab exists/)
  const withModel = entry(0, { id: 'm', sources: ['*'], model: 'opus', playbook: 'check' })
  const plain = entry(1, { id: 'p', sources: ['*'], playbook: 'check' })
  const rows = V.ruleRows(withLv({ entries: [withModel, plain] }, { takeover: 'unknown' }), 'project')
  assert.match(rows[0].warnings.at(-1), /unknown until a Claude tab exists/)
  assert.deepEqual(rows[1].warnings, [])
  assert.deepEqual(V.ruleRows(withLv({ entries: [withModel] }, { takeover: 'no' }), 'project')[0].warnings, [], 'the host adds the "no" warning itself')
  assert.deepEqual(V.ruleRows(withLv({ entries: [withModel] }, { takeover: 'yes' }), 'project')[0].warnings, [])
})

test('the Running tab: rows with since and flags (update waiting, taken over, stopped), the queue, the slots', () => {
  const m = V.runningModel({
    slots: 2,
    maxRunning: 3,
    running: [
      { rule: 'down', source: 'bronos.jira', itemId: 'SUP-1', tabId: 't1', status: 'working', openedAt: NOW - 60000, deliveries: 2, pending: 7, takenOver: false, stopped: false },
      { rule: 'down', source: 'bronos.jira', itemId: 'SUP-2', tabId: 't2', status: 'waiting for input', openedAt: NOW - 24 * 3600000, deliveries: 0, pending: null, takenOver: true, stopped: true },
    ],
    queued: [{ source: 'bronos.gmail', itemId: 'm-9', at: NOW - 120000 }],
  }, NOW)
  assert.equal(m.slots, '2 of 3 slots in use')
  assert.deepEqual(m.rows[0], { title: 'SUP-1', meta: 'down · bronos.jira', status: 'working', since: 'since 13:41', flags: ['update waiting'], updates: '2 updates sent' })
  assert.deepEqual(m.rows[1].flags, ['taken over: you typed in it', 'stopped'])
  assert.equal(m.rows[1].since, 'since 11-02 13:42')
  assert.deepEqual(m.queue, [{ title: 'm-9', meta: 'bronos.gmail', since: 'queued 13:40' }])
  assert.equal(m.empty, '')
  assert.equal(V.runningModel({}, NOW).empty, 'No Autopilot session is running.')
  assert.equal(V.runningModel({}, NOW).slots, '')
})

test('the rule form: from a raw v2 rule and back, in key order; a new rule starts off', () => {
  const raw = {
    id: 'nf',
    name: 'Login broken',
    enabled: true,
    sources: ['bronos.jira', 'bronos.chat'],
    when: [{ field: 'place.name', op: 'is', value: 'Support' }, { field: 'title', op: 'contains', value: 'Login broken' }],
    jev: { question: 'q?', min: 0.8 },
    hours: { from: '22:00', to: '07:00' },
    playbook: 'check',
    check: 'c',
    model: 'sonnet',
    effort: 'high',
    onChange: true,
    limits: { perDay: 5, cooldownMinutes: 0 },
  }
  const f = V.formFromRaw(raw, ST, 'project')
  assert.deepEqual([f.sourceAny, f.sources, f.jevOn, f.min, f.perDay, f.cooldownMinutes, f.model, f.effort], [false, ['bronos.jira', 'bronos.chat'], true, '0.8', '5', '0', 'sonnet', 'high'])
  assert.deepEqual(V.formToRule(f), raw)
  // Every key in file order but act (a session rule) and mode (left out at its default, investigate).
  assert.deepEqual(Object.keys(V.formToRule(f)), S.RULE_KEYS.filter((k) => k !== 'act' && k !== 'mode'))
  const fresh = V.formFromRaw(null, ST, 'project')
  assert.deepEqual([fresh.enabled, fresh.playbook, fresh.perDay, fresh.cooldownMinutes, fresh.jevOn, fresh.sources, fresh.sourceAny, fresh.model, fresh.confirmAll], [false, 'check', '10', '30', false, [], false, '', false])
  const out = V.formToRule({ ...fresh, id: 'x', sources: ['bronos.jira'], when: [{ field: 'title', op: 'contains', value: 'down' }], perDay: '', cooldownMinutes: ' ' })
  assert.deepEqual(out.limits, S.LIMIT_DEFAULTS, 'an empty number is the default')
  for (const k of ['name', 'jev', 'hours', 'check', 'model', 'effort']) assert.equal(Object.hasOwn(out, k), false, `${k} stays out when empty (Default)`)
  assert.deepEqual(V.formToRule({ ...fresh, id: 'x', sourceAny: true, sources: ['stale'] }).sources, ['*'], 'Any source is ["*"] alone')
  // An invalid entry still fills the form as far as it can be read; a stray non-object condition stays visible as an empty one.
  const odd = V.formFromRaw({ id: 7, sources: 'bronos.jira', when: [null, { field: 'title', op: 'contains', value: 'x' }], limits: { perDay: 'many' } }, ST, 'project')
  assert.deepEqual([odd.id, odd.sources, odd.perDay, odd.when.length, odd.when[0]], ['7', ['bronos.jira'], 'many', 2, { field: '', op: '', value: '' }])
  assert.match(V.formErrors({ ...odd, id: 'odd', playbook: 'check' }, ST, null)['when[1]'], /not a valid condition/)
  assert.equal(V.formFromRaw(null, withLv({ playbookFiles: [] }), 'project').playbook, V.NEW_PLAYBOOK)
})

test('form errors: the loader\'s own, per field, plus a unique id, the confirmation and a free new playbook name', () => {
  const base = { ...V.formFromRaw(null, ST, 'project'), id: 'new', sources: ['bronos.jira'], when: [{ field: 'title', op: 'contains', value: 'down' }] }
  assert.deepEqual(V.formErrors(base, ST, null), {})
  const e = V.formErrors({ ...base, id: 'a b', sources: [], perDay: '0', cooldownMinutes: '1.5', jevOn: true, question: '', min: '2', model: 'gpt', effort: 'loud', check: 'x'.repeat(501) }, ST, null)
  assert.deepEqual(Object.keys(e).sort(), ['check', 'effort', 'id', 'jev.min', 'jev.question', 'limits.cooldownMinutes', 'limits.perDay', 'model', 'sources'].sort())
  assert.match(e.sources, /empty list/)
  assert.match(V.formErrors({ ...base, perDay: 'ten' }, ST, null)['limits.perDay'], /whole number from 1 to 100/)
  assert.match(V.formErrors({ ...base, id: 'a' }, ST, null).id, /used by another project rule/)
  assert.deepEqual(V.formErrors({ ...base, id: 'a' }, ST, 0), {}, 'its own id is fine when editing it')
  assert.match(V.formErrors({ ...base, id: 'bad id' }, ST, null).id, /^id must be/)
  // A sources-only rule (no condition, no Jev question) is saved only once the person confirmed it.
  const bare = { ...base, when: [] }
  assert.match(V.formErrors(bare, ST, null).when, /fires on every new item/)
  assert.deepEqual(V.formErrors({ ...bare, confirmAll: true }, ST, null), {})
  assert.deepEqual(V.formErrors({ ...bare, jevOn: true, question: 'Is it?' }, ST, null), {}, 'a Jev question stands in for conditions')
  assert.equal(S.checkRule(V.formToRule({ ...bare, confirmAll: true })).errors.length, 0, 'the loader accepts a sources-only rule')
  assert.match(V.formErrors({ ...base, when: [{ field: 'title', op: 'contains', value: '' }] }, ST, null)['when[1]'], /not a valid condition/)
  assert.match(V.formErrors({ ...base, playbook: V.NEW_PLAYBOOK, newPlaybook: '' }, ST, null).playbook, /name the new playbook/)
  assert.match(V.formErrors({ ...base, playbook: V.NEW_PLAYBOOK, newPlaybook: 'spare' }, ST, null).playbook, /exists/)
  assert.match(V.formErrors({ ...base, playbook: V.NEW_PLAYBOOK, newPlaybook: '../x' }, ST, null).playbook, /^playbook must be a file name/)
  assert.deepEqual(V.formErrors({ ...base, playbook: V.NEW_PLAYBOOK, newPlaybook: 'brand-new' }, ST, null), {})
  assert.match(V.formErrors({ ...base, sources: ['../x'] }, ST, null).sources, /plugin ids/)
  assert.match(V.formErrors({ ...base, sourceAny: true, sources: [] , hoursMode: 'set', hoursFrom: '', hoursTo: '07:00' }, ST, null)['hours.from'], /HH:MM/)
})

test('condition editor: add, remove, field and op changes keep what fits, values parse by kind', () => {
  const T = V.condTable()
  assert.deepEqual(V.condDefault(T), { field: 'sourceKind', op: 'is', value: 'chat' })
  let w = V.condAdd([], T)
  w = V.condSet(w, 0, { field: 'title' }, T)
  assert.deepEqual(w, [{ field: 'title', op: 'is', value: '' }], 'a new kind resets the value, an op the field takes is kept')
  w = V.condSet(w, 0, { value: 'down' }, T)
  w = V.condSet(w, 0, { field: 'preview' }, T)
  assert.deepEqual(w[0], { field: 'preview', op: 'is', value: 'down' }, 'the same kind keeps op and value')
  w = V.condSet(w, 0, { op: 'startsWith' }, T)
  assert.equal(w[0].op, 'startsWith')
  w = V.condSet(w, 0, { op: 'in' }, T)
  assert.equal(w[0].op, 'startsWith', 'an op the field does not take is ignored')
  w = V.condSet(V.condSet(w, 0, { field: 'from.name' }, T), 0, { op: 'in' }, T)
  assert.deepEqual(w[0], { field: 'from.name', op: 'in', value: ['down'] }, 'in takes a list (the one value becomes its first entry)')
  w = V.condSet(w, 0, { value: V.condParse('Ann\n\n Bob ', 'text', 'in') }, T)
  assert.deepEqual(w[0].value, ['Ann', 'Bob'])
  assert.equal(V.condValueText(w[0].value), 'Ann\nBob')
  assert.deepEqual(V.condSet(w, 0, { op: 'is' }, T)[0].value, 'Ann', 'back to one value keeps the first')
  assert.deepEqual(w, JSON.parse(JSON.stringify(w)), 'the input is never changed')
  assert.deepEqual(V.condRemove(V.condAdd(V.condAdd([], T), T), 0).length, 1)
  assert.deepEqual([V.condParse('15', 'minutes', 'newerThan'), V.condParse('x', 'minutes', 'newerThan'), V.condParse('true', 'bool', 'is'), V.condParse('null', 'read', 'is'), V.condParse('false', 'read', 'is')], [15, 'x', true, null, false])
  assert.deepEqual(V.condControl({ field: 'sourceKind', op: 'in' }, T), { type: 'checks', options: ['chat', 'mail', 'issues', 'other'] })
  assert.deepEqual(V.condControl({ field: 'to', op: 'is' }, T), { type: 'select', options: ['direct', 'group', 'cc', 'none'] })
  assert.equal(V.condControl({ field: 'time', op: 'newerThan' }, T).type, 'number')
  assert.equal(V.condControl({ field: 'place.name', op: 'in' }, T).type, 'lines')
  assert.equal(V.condControl({ field: 'title', op: 'contains' }, T).type, 'text')
  // 0.4.0: notIn is a list op like in; jira.category picks from Jira's three categories.
  assert.equal(V.condControl({ field: 'jira.status', op: 'notIn' }, T).type, 'lines')
  assert.deepEqual(V.condControl({ field: 'jira.category', op: 'is' }, T), { type: 'select', options: ['new', 'indeterminate', 'done'] })
  assert.deepEqual(V.condSet([{ field: 'jira.status', op: 'is', value: 'Done' }], 0, { op: 'notIn' }, T)[0].value, ['Done'])
  assert.deepEqual(V.condOpOptions('time', T).map((o) => o.label), ['newer than (minutes)', 'older than (minutes)'])
  assert.deepEqual(V.condFieldOptions({ field: 'nope' }, T)[0], { value: 'nope', label: 'nope (not a field)' })
  // Every field with every op it offers, given a value of its kind, passes the loader's own check.
  const sample = { text: 'x', kind: 'chat', to: 'direct', bool: true, read: null, minutes: 5, category: 'done' }
  for (const field of Object.keys(T.fields)) {
    for (const op of T.fields[field].ops) {
      const d = V.condSet(V.condSet(V.condAdd([], T), 0, { field }, T), 0, { op }, T)
      const v = op === 'in' || op === 'notIn' ? [sample[T.fields[field].value]] : sample[T.fields[field].value]
      const when = V.condSet(d, 0, { value: v }, T)
      assert.deepEqual(S.checkRule({ id: 'x', sources: ['*'], when, playbook: 'p' }).errors, [], `${field} ${op}`)
    }
  }
})

test('sources picker: running feeds first, the rule\'s own unknown ids kept and marked', () => {
  assert.deepEqual(V.sourceChoices(ST, []), [{ id: 'bronos.jira', label: 'Jira (bronos.jira)', known: true }, { id: 'bronos.gmail', label: 'Mail (bronos.gmail)', known: true }])
  assert.deepEqual(V.sourceChoices(ST, ['bronos.jira', 'bronos.chat']).at(-1), { id: 'bronos.chat', label: 'bronos.chat (no such source here)', known: false })
  assert.deepEqual(V.sourceToggle(['a.b'], 'c.d', true), ['a.b', 'c.d'])
  assert.deepEqual(V.sourceToggle(['a.b', 'c.d'], 'a.b', false), ['c.d'])
  assert.deepEqual(V.sourceToggle(['a.b'], 'a.b', true), ['a.b'])
  // An unknown id survives a round trip through the form.
  const f = V.formFromRaw({ id: 'x', sources: ['bronos.chat'], playbook: 'check' }, ST, 'project')
  assert.deepEqual(V.formToRule(f).sources, ['bronos.chat'])
})

test('dropdowns: model and effort start with Default; the playbook list', () => {
  assert.deepEqual(V.choiceOptions(S.MODEL_LIST, '').map((o) => o.label), ['Default', 'haiku', 'sonnet', 'opus', 'fable'])
  assert.deepEqual(V.choiceOptions(S.EFFORT_LIST, 'loud').at(-1), { value: 'loud', label: 'loud (not a known value)' })
  // A link is listed: the loader reads through it (only the panel's editor will not write it).
  assert.deepEqual(V.playbookOptions(ST, 'check', 'project').map((o) => o.value), ['check', 'spare', 'ln', V.NEW_PLAYBOOK])
  assert.deepEqual(V.playbookOptions(ST, 'gone', 'project').map((o) => o.label), ['check', 'spare', 'ln', 'gone (missing)', 'New playbook…'])
  assert.equal(S.PLAYBOOK_NAME.test(V.NEW_PLAYBOOK), false, '"New playbook…" can never be a real name')
})

test('playbooks: rows, used-by, the delete refusal, the editor checks', () => {
  const rows = V.playbookRows(ST, 'project')
  assert.deepEqual(rows.map((r) => [r.name, r.used, r.canEdit, r.canDelete]), [['check', 'used by: a', true, true], ['spare', 'not used by a rule', true, true], ['a.b', 'not used by a rule', false, false], ['ln', 'not used by a rule', false, false]])
  assert.equal(rows[0].size, '2 KiB')
  assert.match(rows[3].note, /symbolic link/)
  assert.equal(V.deleteBlocked(rows[0]), 'check is used by: a. Change or delete those rules first.')
  assert.equal(V.deleteBlocked(rows[1]), '')
  assert.deepEqual(V.playbookErrors({ level: 'project', name: 'fresh', body: '# x', isNew: true }, ST), {})
  for (const name of ['../x', '/etc/passwd', 'a.b', '', 'x/y']) assert.ok(V.playbookErrors({ level: 'project', name, body: 'x', isNew: true }, ST).name, name)
  assert.match(V.playbookErrors({ level: 'project', name: 'spare', body: 'x', isNew: true }, ST).name, /exists/)
  assert.deepEqual(V.playbookErrors({ level: 'project', name: 'spare', body: 'x', isNew: false }, ST), {}, 'editing it is fine')
  assert.match(V.playbookErrors({ level: 'project', name: 'p', body: ' \n', isNew: true }, ST).body, /empty/)
  assert.match(V.playbookErrors({ level: 'project', name: 'p', body: 'é'.repeat(S.MAX_PLAYBOOK_BYTES / 2 + 1), isNew: true }, ST).body, /over 64 KiB/, 'bytes, not characters')
  assert.equal(V.sizeText('x'.repeat(1536)), '1.5 of 64 KiB')
})

test('the render gate holds a redraw while a button is down and draws once after', () => {
  let draws = 0
  const later = []
  const g = V.createRenderGate(() => draws++, (fn) => later.push(fn))
  g.request()
  assert.equal(draws, 1)
  g.down()
  g.request()
  g.request()
  assert.equal(draws, 1)
  g.up()
  later.shift()()
  assert.equal(draws, 2)
})

// Found in the real app (a 1280 px window, the panel about 370 px wide): a settings-style row sized
// its control first, so the Level select (whose options carry a folder path) and the 220 px text
// inputs squeezed the label to one letter per line, and the four tabs ran past the edge.
test('the stylesheet lets rows and tabs wrap in a narrow side panel', () => {
  const css = fs.readFileSync(path.join(__dirname, '../panels/main.html'), 'utf8')
  const rule = (sel) => {
    const at = css.indexOf(`${sel} {`)
    assert.notEqual(at, -1, `no rule for ${sel}`)
    return css.slice(at, css.indexOf('}', at))
  }
  assert.match(rule('.set .field'), /flex-wrap: wrap/)
  assert.match(rule('.set .field .lbl'), /flex: 1 1 \d+px/)
  assert.match(rule('.set .field .ctl select'), /max-width: \d+px/)
  assert.doesNotMatch(rule('.tabs'), /flex-wrap: wrap[;\s]/, 'the four tabs never wrap to a second row')
})

test('the tabs stay on one row at a 460 px panel: no wrap, a sideways scroll with no scrollbar', () => {
  const css = fs.readFileSync(path.join(__dirname, '../panels/main.html'), 'utf8')
  const rule = (sel) => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)))
  assert.match(rule('.tabs'), /flex-wrap: nowrap/)
  assert.match(rule('.tabs'), /overflow-x: auto/)
  assert.match(rule('.tabs'), /scrollbar-width: none/)
  assert.match(css, /\.tabs::-webkit-scrollbar \{ display: none; \}/)
  assert.match(rule('.tabs button'), /flex: none/)
  // The widest labels (two digits each) at 12 px, about 6.5 px a character plus the padding, fit 460.
  const labels = ['Rules (12)', 'Running (12)', 'Playbooks (12)', 'Log (50)']
  const pad = Number(/padding: 0 (\d+)px/.exec(rule('.tabs button'))[1]) * 2
  const size = Number(/font-size: (\d+)px/.exec(rule('.tabs button'))[1])
  assert.ok(size <= 12)
  const width = labels.reduce((a, l) => a + l.length * size * 0.55 + pad, 0)
  assert.ok(width < 440, `about ${Math.round(width)} px`)
})

// ---- 0.3.0: act rules, mode, base.md ----

test('the rule form: an act rule round-trips with no session keys; an empty action shows the loader\'s error', () => {
  const raw = { id: 'mr', enabled: false, sources: ['bronos.gmail'], when: [{ field: 'title', op: 'contains', value: 'Done' }], act: 'markRead', limits: { perDay: 50, cooldownMinutes: 5 } }
  const f = V.formFromRaw(raw, ST, 'project')
  assert.deepEqual([f.kind, f.act, f.mode], ['act', 'markRead', 'investigate'])
  assert.deepEqual(V.formToRule(f), raw)
  // Session fields left in the form from before the kind changed are not written.
  assert.deepEqual(V.formToRule({ ...f, playbook: 'check', model: 'sonnet', effort: 'low', check: 'c', onChange: true, mode: 'act' }), raw)
  assert.deepEqual(V.formErrors(f, ST, null), {})
  assert.ok(V.formErrors({ ...f, act: '' }, ST, null).act)
  assert.ok(V.formErrors({ ...f, act: 'open' }, ST, null).act)
  // The "New playbook…" check is a session rule's only.
  assert.deepEqual(V.formErrors({ ...f, playbook: V.NEW_PLAYBOOK, newPlaybook: '' }, ST, null), {})
  // Switched to a session rule: a playbook and no act; act mode kept, the default left out.
  const s = V.formToRule({ ...f, kind: 'session', playbook: 'check', mode: 'act' })
  assert.deepEqual([s.act, s.playbook, s.mode], [undefined, 'check', 'act'])
  assert.equal('mode' in V.formToRule({ ...f, kind: 'session', playbook: 'check', mode: 'investigate' }), false)
  assert.deepEqual(V.ACT_CHOICES, ['markRead', 'markUnread', 'done'])
  assert.equal(V.ACT_CHOICES.includes('open'), false)
})

test('the mode warning: none for investigate or an act rule; act mode warns, more strongly when outsiders can trigger the rule', () => {
  const f = V.formFromRaw(null, ST, 'project')
  assert.equal(V.modeWarning({ ...f, mode: 'investigate', sources: ['bronos.gmail'] }, ST), '')
  assert.equal(V.modeWarning({ ...f, kind: 'act', mode: 'act', sources: ['bronos.gmail'] }, ST), '')
  assert.equal(V.modeWarning({ ...f, mode: 'act', sources: ['bronos.jira'] }, ST), V.MODE_WARN)
  assert.equal(V.modeWarning({ ...f, mode: 'act', sources: ['bronos.gmail'] }, ST), V.MODE_WARN_OUTSIDERS)
  assert.equal(V.modeWarning({ ...f, mode: 'act', sourceAny: true, sources: [] }, ST), V.MODE_WARN_OUTSIDERS)
  assert.match(V.MODE_WARN, /Claude Code's own permission settings still apply/)
})

test('base.md rows: per level with a folder; in use, not set, or a problem; the editor\'s cap', () => {
  const st = { ...ST, levels: [{ ...LV, base: { size: 3000 }, baseProblem: null }, { ...GL, folder: '/g', folderState: 'ok', base: null, baseProblem: 'base.md: over 16 KiB' }] }
  const rows = V.baseRows(st)
  assert.deepEqual(rows.map((r) => [r.level, r.label, r.inUse, r.canEdit]), [['project', 'Project base.md', true, true], ['global', 'Global base.md', false, true]])
  assert.match(rows[0].text, /^in use: every session prompt carries it \(3 KiB\)$/)
  assert.match(rows[1].text, /cannot be used: no session opens until it is fixed/)
  assert.equal(rows[1].problem, 'base.md: over 16 KiB')
  assert.match(V.baseRows(withLv({ base: null }))[0].text, /^not set/)
  assert.equal(V.baseRows(ST).length, 1, 'a level with no folder has no row')
  assert.deepEqual(V.baseErrors(''), {}, 'an empty text is allowed: it removes the file')
  assert.deepEqual(V.baseErrors('x'.repeat(S.MAX_BASE_BYTES)), {})
  assert.deepEqual(V.baseErrors('x'.repeat(S.MAX_BASE_BYTES + 1)), { body: 'over 16 KiB' })
  assert.equal(V.baseSizeText('x'.repeat(2048)), '2.0 of 16 KiB')
})

test('log rows: an act rule\'s action that ran is a fire with its outcome; a failed one a skip', () => {
  const done = V.logModel({ at: NOW, rule: 'project:mr', source: 'bronos.gmail', itemId: 'm1', title: 'Ticket Done', step: 'act', act: 'markRead', outcome: 'marked read: Ticket Done', also: ['global:x'] }, NOW)
  assert.deepEqual(done, { kind: 'fired', when: '13:42', title: 'Ticket Done', meta: 'project:mr · bronos.gmail', outcome: 'marked read: Ticket Done; also matched: global:x' })
  const failed = V.logModel({ at: NOW, rule: 'project:mr', source: 'bronos.gmail', itemId: 'm1', title: 'Ticket Done', step: 'act', skip: 'markRead failed: no such item' }, NOW)
  assert.deepEqual([failed.kind, failed.outcome], ['skipped', 'skipped (act): markRead failed: no such item'])
})

test('the sources note is worded per kind; an act rule keeps a playbook ready for a switch to a session; base sizes in bytes', () => {
  const f = V.formFromRaw({ id: 'mr', sources: ['bronos.gmail'], act: 'markRead' }, ST, 'project')
  assert.equal(f.playbook, 'check', 'the level\'s first playbook, not an empty pick')
  assert.equal(V.outsidersNote(f, ST), V.OUTSIDERS_ACT)
  assert.equal(V.outsidersNote({ ...f, kind: 'session' }, ST), V.OUTSIDERS)
  assert.equal(V.outsidersNote({ ...f, sources: ['bronos.jira'] }, ST), '')
  assert.doesNotMatch(V.OUTSIDERS_ACT, /session/)
  const row = (size) => V.baseRows(withLv({ base: { size } }))[0].text
  assert.match(row(10), /\(10 bytes\)$/)
  assert.match(row(3000), /\(3 KiB\)$/)
})

test('the rule form: the limits show the kind\'s default, and a kind change moves only untouched ones', () => {
  const act = V.formFromRaw({ id: 'mr', sources: ['bronos.gmail'], act: 'markRead' }, ST, 'project')
  assert.deepEqual([act.perDay, act.cooldownMinutes], ['100', '0'])
  const ses = V.formFromRaw({ id: 's', sources: ['bronos.jira'], playbook: 'check' }, ST, 'project')
  assert.deepEqual([ses.perDay, ses.cooldownMinutes], ['10', '30'])
  // A new rule starts as a session; switched to an action, both defaults follow; back again, too.
  const fresh = V.formFromRaw(null, ST, 'project')
  assert.deepEqual(V.kindLimits({ ...fresh, kind: 'act' }, 'session'), { perDay: '100', cooldownMinutes: '0' })
  assert.deepEqual(V.kindLimits({ ...act, kind: 'session' }, 'act'), { perDay: '10', cooldownMinutes: '30' })
  // A number the person typed stays; an empty field takes the new default.
  assert.deepEqual(V.kindLimits({ ...fresh, kind: 'act', perDay: '20', cooldownMinutes: '' }, 'session'), { perDay: '20', cooldownMinutes: '0' })
  assert.deepEqual(V.kindLimits({ ...fresh, kind: 'session', perDay: '20' }, 'session'), { perDay: '20', cooldownMinutes: '30' }, 'no change of kind')
  // An empty number saves as the kind's default.
  const out = V.formToRule({ ...act, enabled: false, when: [{ field: 'title', op: 'contains', value: 'Done' }], perDay: '', cooldownMinutes: '' })
  assert.deepEqual(out.limits, S.ACT_LIMIT_DEFAULTS)
})
