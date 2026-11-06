'use strict'
// Rule validation (strict, like Inbox's settings), playbook names and front matter, the folder
// setting, and reading the folder with a missing or broken file.
const test = require('node:test')
const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const path = require('node:path')
const R = require('../dist/lib/rules')
const S = require('../dist/lib/schema')
const { tempFolder, removeFolder, rule, fakeStorage, NOW } = require('./fakes')
const { createState } = require('../dist/lib/state')

const fullRule = (o = {}) => ({
  id: 'deploy-failed',
  name: 'Failed deploys',
  enabled: true,
  sources: ['bronos.chat', 'bronos.jira'],
  when: [{ field: 'place.name', op: 'is', value: ' Deploys ' }, { field: 'labels', op: 'has', value: 'prod' }],
  jev: { question: 'Did a production deploy fail?', min: 0.8 },
  hours: { from: '08:00', to: '19:00' },
  playbook: 'investigate-deploy',
  check: 'A production deploy failed.',
  model: 'opus',
  effort: 'xhigh',
  onChange: true,
  limits: { perDay: 5, cooldownMinutes: 0 },
  ...o,
})

test('a full rule is read whole, with the defaults filled in', () => {
  const { rules, problems } = R.readRules([fullRule(), rule('plain')])
  assert.deepEqual(problems, [])
  const [a, b] = rules
  assert.deepEqual(a.sources, ['bronos.chat', 'bronos.jira'])
  assert.deepEqual(a.when, [{ field: 'place.name', op: 'is', value: 'Deploys' }, { field: 'labels', op: 'has', value: 'prod' }], 'values are trimmed like Inbox')
  assert.deepEqual(a.jev, { question: 'Did a production deploy fail?', min: 0.8 })
  assert.deepEqual(a.hours, { from: '08:00', to: '19:00' })
  assert.deepEqual([a.name, a.check, a.model, a.effort, a.onChange, a.enabled], ['Failed deploys', 'A production deploy failed.', 'opus', 'xhigh', true, true])
  assert.deepEqual(a.limits, { perDay: 5, cooldownMinutes: 0 })
  assert.deepEqual(a.warnings, [])
  assert.deepEqual([b.enabled, b.onChange, b.jev, b.hours, b.name, b.model, b.effort], [true, false, null, null, null, null, null])
  assert.deepEqual(b.limits, R.LIMIT_DEFAULTS)
  assert.equal(R.readRules([rule('j', { jev: { question: 'q?' } })]).rules[0].jev.min, R.JEV_MIN_DEFAULT)
  assert.equal(R.readRules([rule('off', { enabled: false })]).rules[0].enabled, false)
  // fable is the person's choice: core accepts it, so the rule does too.
  assert.equal(R.readRules([rule('f', { model: 'fable' })]).rules[0].model, 'fable')
})

test('every field: valid and invalid values (a bad rule is a problem naming it and is skipped)', () => {
  const cases = [
    [rule('a', { name: 'x'.repeat(61) }), /name must be text of at most 60/],
    [rule('a', { name: 7 }), /name must be text/],
    [rule('a', { enabled: 'yes' }), /enabled must be/],
    [rule('a', { onChange: 1 }), /onChange must be/],
    [rule('a', { when: 'title' }), /when must be a list/],
    [rule('a', { when: [{ field: 'title', op: 'matches', value: '.*' }] }), /when\[1\] is not a valid condition/],
    [rule('a', { when: [{ field: 'title', op: 'contains', value: 'x' }, 'read is false'] }), /when\[2\]/],
    [rule('a', { when: Array.from({ length: 21 }, () => ({ field: 'title', op: 'contains', value: 'x' })) }), /more than 20 conditions/],
    [rule('a', { jev: 'is it?' }), /jev must be an object/],
    [rule('a', { jev: {} }), /jev.question is missing/],
    [rule('a', { jev: { question: 'q', min: 2 } }), /jev.min must be/],
    [rule('a', { jev: { question: 'q'.repeat(1001) } }), /jev.question is over 1000/],
    [rule('a', { hours: { from: '25:00', to: '07:00' } }), /hours.from/],
    [rule('a', { hours: { from: '07:00', to: '07:00' } }), /hours.from and hours.to are the same/],
    [rule('a', { playbook: '../../.ssh/id_rsa' }), /playbook must be a file name/],
    [rule('a', { playbook: 'a.md' }), /playbook must be a file name/],
    [rule('a', { playbook: undefined }), /playbook is missing: name a playbook .* or an act/],
    [rule('a', { check: 7 }), /check must be text/],
    [rule('a', { check: 'c'.repeat(501) }), /check is over 500/],
    [rule('a', { model: 'gpt' }), /model must be one of haiku, sonnet, opus, fable/],
    [rule('a', { model: 'Fable' }), /model must be one of/],
    [rule('a', { effort: 'ultra' }), /effort must be one of low, medium, high, xhigh, max/],
    [rule('a', { limits: { perDay: 0 } }), /limits.perDay/],
    [rule('a', { limits: { cooldownMinutes: 1.5 } }), /limits.cooldownMinutes/],
    [rule('a b'), /id must be/],
    ['a string', /must be an object/],
  ]
  for (const [bad, re] of cases) {
    const { rules, problems } = R.readRules([bad, rule('good')])
    assert.deepEqual(rules.map((r) => r.id), ['good'], JSON.stringify(bad))
    assert.equal(problems.length, 1)
    assert.match(problems[0], re)
    assert.match(problems[0], /^rule 1.*skipped$/)
  }
  // Every listed value of the enum fields is accepted; the empty when is a sources-only rule.
  for (const model of S.MODEL_LIST) assert.equal(R.readRules([rule('m', { model })]).problems.length, 0, model)
  for (const effort of S.EFFORT_LIST) assert.equal(R.readRules([rule('e', { effort })]).problems.length, 0, effort)
  for (const when of [[], undefined]) {
    const r = R.readRules([rule('s', { when })])
    assert.deepEqual(r.problems, [])
    assert.deepEqual(r.rules[0].when, [])
  }
  assert.equal(R.readRules([rule('s', { when: Array.from({ length: 20 }, () => ({ field: 'title', op: 'contains', value: 'x' })) })]).problems.length, 0, '20 conditions are the limit')
  // Duplicate ids: the first wins.
  const dup = R.readRules([rule('x'), rule('x', { playbook: 'other' })])
  assert.equal(dup.rules.length, 1)
  assert.equal(dup.rules[0].playbook, 'check')
  assert.match(dup.problems[0], /rule 2 \("x"\): id "x" is used by an earlier rule/)
  assert.match(R.readRules({ rules: [] }).problems[0], /must be a list/)
})

test('sources is required: missing, empty, wrong type and bad ids are refused, never "any"', () => {
  const bad = [
    [undefined, /sources is missing: choose the sources/],
    [null, /sources is missing/],
    [[], /sources is an empty list: choose the sources/],
    ['bronos.chat', /sources must be a list/],
    [{ 0: 'bronos.chat' }, /sources must be a list/],
    [['*', 'bronos.chat'], /"\*" must stand alone/],
    [['bronos.chat', '*'], /"\*" must stand alone/],
    [['*', '*'], /"\*" must stand alone/],
    [['chat'], /sources must hold plugin ids/],
    [['Bronos.Chat'], /sources must hold plugin ids/],
    [['bronos.chat', 7], /sources must hold plugin ids/],
    [['bronos.chat', ''], /sources must hold plugin ids/],
    [['../etc'], /sources must hold plugin ids/],
    [['bronos.1chat'], /sources must hold plugin ids/],
    [['a'.repeat(98) + '.bb'], /sources must hold plugin ids/],
    [Array.from({ length: 21 }, (_, i) => `x.p${String.fromCharCode(97 + i)}`), /more than 20 entries/],
  ]
  for (const [sources, re] of bad) {
    const { rules, problems } = R.readRules([rule('a', { sources })])
    assert.equal(rules.length, 0, JSON.stringify(sources))
    assert.match(problems[0], re, JSON.stringify(sources))
  }
  // A rule written with no sources key at all is the same refusal (rule() cannot leave it out).
  const { sources: _, ...none } = rule('n')
  assert.match(R.readRules([none]).problems[0], /sources is missing/)
  const ok = [
    [['*'], ['*']],
    [['bronos.chat'], ['bronos.chat']],
    [['bronos.chat', 'bronos.chat', 'bronos.jira'], ['bronos.chat', 'bronos.jira']],
    [['a.b'], ['a.b']],
    [['com.example.my-plugin'], ['com.example.my-plugin']],
    [['a'.repeat(96) + '.bb'], ['a'.repeat(96) + '.bb']],
    [Array.from({ length: 20 }, (_, i) => `x.p${String.fromCharCode(97 + i)}`), Array.from({ length: 20 }, (_, i) => `x.p${String.fromCharCode(97 + i)}`)],
  ]
  for (const [sources, want] of ok) {
    const r = R.readRules([rule('a', { sources })])
    assert.deepEqual(r.problems, [], JSON.stringify(sources))
    assert.deepEqual(r.rules[0].sources, want)
  }
  assert.equal(S.MAX_PLUGIN_ID, 100)
  // The app's PLUGIN_ID_PATTERN (src/shared/manifest.ts), copied: same verdicts on its edge cases.
  for (const [id, yes] of [['bronos.chat', true], ['a.b', true], ['a-b.c-d', true], ['single', false], ['a.1', false], ['a..b', false], ['.a.b', false], ['a.b.', false], ['A.b', false], ['a_b.c', false], ['-a.b', false]]) assert.equal(S.PLUGIN_ID.test(id), yes, id)
})

test('a v1 entry (match, triage) in the new file is just an invalid rule; its problem names the v1 key', () => {
  const v1 = { id: 'old', on: true, match: { source: 'bronos.jira', text: ['down'] }, triage: { kind: 'none' }, condition: 'c', playbook: 'check' }
  // A v2 rule with a leftover v1 key is valid: the key is an unknown one, warned about by name.
  const onlyTriage = { id: 'old2', sources: ['bronos.chat'], playbook: 'check', triage: { kind: 'none' } }
  const r = R.readRules([v1, rule('good'), onlyTriage])
  assert.deepEqual(r.rules.map((x) => x.id), ['good', 'old2'])
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0], /^rule 1 \("old"\): sources is missing: choose the sources .*\("match" is a v1 key; v2 rules use sources, when and jev \(see `ccc autopilot format`\)\); skipped$/)
  assert.doesNotMatch(r.problems[0], /rewrite it/, 'no special v1 handling any more')
  assert.equal(r.entries[0].rule, null)
  assert.deepEqual(r.entries[0].raw, v1, 'the entry is kept as written')
  assert.ok(r.entries[0].warnings.includes('unknown key "match" ignored: a v1 key; v2 rules use sources, when and jev (see `ccc autopilot format`)'))
  assert.ok(r.rules[1].warnings.includes('unknown key "triage" ignored: a v1 key; v2 rules use sources, when and jev (see `ccc autopilot format`)'))
  assert.equal(S.isV1, undefined, 'no v1 classification left in the format')
  assert.equal(S.RULES_FILE, 'autopilot-rules.json')
})

test('unknown keys are dropped with a warning; v1 "note" and "on" are unknown now', () => {
  const { rules } = R.readRules([rule('a', { txt: ['x'], note: 'why I wrote this', on: false, jev: { question: 'q', mni: 1 }, limits: { perDay: 2, perHour: 1 } })])
  assert.equal(rules.length, 1)
  assert.equal(Object.hasOwn(rules[0], 'txt'), false)
  assert.equal(rules[0].enabled, true, 'a v1 "on": false does not switch a v2 rule off: it is an unknown key')
  assert.deepEqual(rules[0].warnings, ['unknown key "txt" ignored', 'unknown key "note" ignored', 'unknown key "on" ignored', 'unknown key "mni" in jev ignored', 'unknown key "perHour" in limits ignored'])
})

test('more than 200 rules: the first 200 are read, and that is a problem', () => {
  const { rules, problems, entries } = R.readRules(Array.from({ length: 205 }, (_, i) => rule(`r${i}`)))
  assert.equal(R.MAX_RULES, 200)
  assert.equal(rules.length, 200)
  assert.match(problems[0], /205 rules; only the first 200/)
  // Every entry is listed for the panel, the ones not read with a problem.
  assert.equal(entries.length, 205)
  assert.match(entries[204].problem, /beyond the first 200/)
})

test('playbook front matter: the rule names the model now, every key is dropped with a warning', () => {
  assert.deepEqual(R.parsePlaybook('---\nmodel: sonnet\n---\n# Check\nDo this.\n'), { body: '# Check\nDo this.', warnings: ['model in a playbook is ignored: name the model in the rule'] })
  const p = R.parsePlaybook('---\nmodel: gpt\ncolor: red\n---\nBody')
  assert.equal(p.body, 'Body')
  assert.equal(p.warnings.length, 2)
  assert.deepEqual(R.parsePlaybook('No front matter\n---\nx'), { body: 'No front matter\n---\nx', warnings: [] })
})

test('the folder settings: global defaults to ~/.config, empty is none, relative is refused; project empty is none, relative is in the project', () => {
  const lf = (app, project) => ({ global: R.levelFolder('global', { app, project }, '/home/ann', '/work/p'), project: R.levelFolder('project', { app, project }, '/home/ann', '/work/p') })
  assert.deepEqual(lf({}, {}), { global: { folder: '/home/ann/.config/cc-cockpit-autopilot', problem: null }, project: { folder: null, problem: null } })
  assert.deepEqual(lf({ globalFolder: '  ' }, { projectFolder: '' }).global, { folder: null, problem: null }, 'a cleared global folder is "no global rules"')
  assert.equal(lf({ globalFolder: '~/rules' }, {}).global.folder, '/home/ann/rules')
  assert.equal(lf({ globalFolder: '~' }, {}).global.folder, '/home/ann')
  assert.equal(lf({ globalFolder: '/srv/autopilot' }, {}).global.folder, '/srv/autopilot')
  const rel = lf({ globalFolder: 'rules' }, {}).global
  assert.equal(rel.folder, null)
  assert.match(rel.problem, /global rules folder "rules" must be an absolute path or start with ~/)
  assert.equal(lf({}, { projectFolder: '.autopilot' }).project.folder, '/work/p/.autopilot')
  assert.equal(lf({}, { projectFolder: '~/p-rules' }).project.folder, '/home/ann/p-rules')
  assert.equal(lf({}, { projectFolder: '/srv/p' }).project.folder, '/srv/p')
  assert.equal(R.displayPath('/home/ann/.config/x', '/home/ann'), '~/.config/x')
  assert.equal(R.displayPath('/srv/x', '/home/ann'), '/srv/x')
})

test('loadLevels: project rules first, then global; refs and levels on every rule; problems name their level', async () => {
  const proj = tempFolder([rule('down'), rule('bad', { playbook: '../x' })], { check: 'Project check.' })
  const glob = tempFolder([rule('down'), rule('mail')], { check: 'Global check.' })
  try {
    const got = await R.loadLevels({ app: { globalFolder: glob }, project: { projectFolder: proj } }, { home: '/home/ann', projectDir: '/work/p', fs: fsp })
    assert.deepEqual(got.rules.map((r) => r.ref), ['project:down', 'global:down', 'global:mail'], 'the same id in both levels is two rules')
    assert.deepEqual(got.rules.map((r) => r.level), ['project', 'global', 'global'])
    assert.equal(got.levels.project.playbooks.get('check').body, 'Project check.', "each level reads its own playbooks/")
    assert.equal(got.levels.global.playbooks.get('check').body, 'Global check.')
    assert.deepEqual(got.problems.length, 1)
    assert.match(got.problems[0], /^project: rule 2 \("bad"\): playbook must be/)
    assert.deepEqual(got.hints, [])
    // A level with no folder is null and adds nothing.
    const one = await R.loadLevels({ app: { globalFolder: '' }, project: { projectFolder: proj } }, { home: '/home/ann', projectDir: '/work/p', fs: fsp })
    assert.equal(one.levels.global, null)
    assert.deepEqual(one.rules.map((r) => r.ref), ['project:down'])
  } finally {
    removeFolder(proj)
    removeFolder(glob)
  }
})

test('a v1 rules.json is never read: with no autopilot-rules.json it is a plain hint, never a problem', async () => {
  const v1 = JSON.stringify([{ id: 'old', match: { source: 'bronos.jira' }, playbook: 'check' }])
  const onlyV1 = tempFolder(undefined, { check: 'x' }, v1)
  const both = tempFolder([rule('new')], { check: 'x' }, v1)
  const broken = tempFolder(undefined, { check: 'x' }, '[ not json')
  try {
    const a = await R.loadFolder(onlyV1, fsp, 'global')
    assert.deepEqual(a.rules, [])
    assert.deepEqual(a.problems, [], 'the hint is never an error')
    assert.equal(a.folderState, 'noRules')
    assert.equal(a.hint, R.V1_HINT)
    assert.match(a.hint, /an old v1 rules.json is in this folder and is not read .*autopilot-rules skill on request/)
    // Broken v1 JSON changes nothing: the file is never opened.
    assert.equal((await R.loadFolder(broken, fsp)).hint, R.V1_HINT)
    // Next to a new file: no hint, and only the new file's rules.
    const b = await R.loadFolder(both, fsp, 'project')
    assert.deepEqual(b.rules.map((r) => r.ref), ['project:new'])
    assert.equal(b.hint, null)
    const lv = await R.loadLevels({ app: { globalFolder: onlyV1 }, project: {} }, { home: '/home/ann', projectDir: '/work/p', fs: fsp })
    assert.deepEqual(lv.problems, [])
    assert.deepEqual(lv.hints, [{ level: 'global', folder: onlyV1, text: R.V1_HINT }])
  } finally {
    for (const d of [onlyV1, both, broken]) removeFolder(d)
  }
})

test('loadFolder: the rules with their playbooks; a missing playbook skips only its rule', async () => {
  const dir = tempFolder([rule('a'), rule('b', { playbook: 'missing' }), rule('c', { playbook: 'modelled' })], { check: 'Look at it.', modelled: '---\nmodel: opus\n---\nDeep look.' })
  try {
    const got = await R.loadFolder(dir, fsp)
    assert.deepEqual(got.rules.map((r) => r.id), ['a', 'c'])
    assert.equal(got.problems.length, 1)
    assert.match(got.problems[0], /rule "b": playbook playbooks\/missing.md: not found; skipped/)
    assert.equal(got.playbooks.get('check').body, 'Look at it.')
    const c = got.rules.find((r) => r.id === 'c')
    assert.equal(c.model, null, "a playbook's model is not the rule's")
    assert.deepEqual(c.warnings, ['playbook modelled: model in a playbook is ignored: name the model in the rule'])
  } finally {
    removeFolder(dir)
  }
})

test('loadFolder: a missing folder, a missing autopilot-rules.json, broken JSON, an empty or huge playbook', async () => {
  const gone = path.join(require('node:os').tmpdir(), 'autopilot-no-such-folder-xyz')
  const a = await R.loadFolder(gone, fsp)
  assert.deepEqual(a.rules, [])
  assert.match(a.problems[0], /folder .* not found: create it/)

  const empty = tempFolder(undefined)
  const broken = tempFolder('[{"id": "a",, }]')
  const odd = tempFolder([rule('a'), rule('b', { playbook: 'big' })], { check: '   \n', big: 'x'.repeat(R.MAX_PLAYBOOK_BYTES + 1) })
  try {
    assert.match((await R.loadFolder(empty, fsp)).problems[0], /^autopilot-rules.json: not found$/)
    const b = await R.loadFolder(broken, fsp)
    assert.deepEqual(b.rules, [])
    assert.match(b.problems[0], /autopilot-rules.json is not valid JSON/)
    const c = await R.loadFolder(odd, fsp)
    assert.deepEqual(c.rules, [])
    assert.match(c.problems.join('\n'), /check.md: empty/)
    assert.match(c.problems.join('\n'), /big.md: over 64 KiB/)
  } finally {
    for (const d of [empty, broken, odd]) removeFolder(d)
  }
})

test('summaryOf: one line with the sources, the conditions, Jev, the playbook, model and limits', () => {
  const [r] = R.readRules([rule('a', { sources: ['bronos.jira'], when: [{ field: 'place.name', op: 'is', value: 'Support' }, { field: 'title', op: 'contains', value: 'down' }], jev: { question: 'q?' }, model: 'opus', effort: 'low', onChange: true })]).rules
  assert.equal(R.summaryOf(r), 'bronos.jira, place.name is Support and title contains down, Jev ≥ 0.7 · playbook check (opus low) · 10/day, 30 min cooldown, again on change')
  const [any] = R.readRules([rule('b', { when: [] })]).rules
  assert.equal(R.summaryOf(any), 'any source, every new item · playbook check · 10/day, 30 min cooldown')
})

// ---- 0.3.0: act rules, the session mode, base.md ----

const actRaw = (o = {}) => ({ id: 'read', sources: ['bronos.gmail'], when: [{ field: 'title', op: 'contains', value: 'Done' }], act: 'markRead', ...o })

test('act or playbook: exactly one; act is an action id and never open', () => {
  const err = (raw) => S.checkRule(raw).errors.map((e) => `${e.field}: ${e.message}`)
  const ok = S.checkRule(actRaw())
  assert.deepEqual(ok.errors, [])
  assert.deepEqual([ok.rule.act, ok.rule.playbook, ok.rule.mode, ok.rule.check, ok.rule.model, ok.rule.effort, ok.rule.onChange], ['markRead', null, null, null, null, null, false])
  assert.match(err(actRaw({ playbook: 'check' }))[0], /^playbook: playbook and act are both set: a rule either opens a session/)
  const { act, ...neither } = actRaw()
  assert.match(err(neither)[0], /^playbook: playbook is missing: name a playbook .* or an act/)
  assert.match(err(actRaw({ act: 'open' }))[0], /^act: act cannot be "open": it opens a window for a person/)
  for (const bad of ['', 'Mark', 'mark read', '1x', 'x'.repeat(41), 5, null, ['markRead']]) assert.match(err(actRaw({ act: bad }))[0], /^act: act must be an action id/, JSON.stringify(bad))
  for (const good of ['markRead', 'markUnread', 'done', 'star', 'add-label']) assert.deepEqual(err(actRaw({ act: good })), [], good)
})

test('an act rule refuses every session key, each under its own field; a session rule takes mode', () => {
  const e = S.checkRule(actRaw({ mode: 'investigate', check: 'x', model: 'sonnet', effort: 'low', onChange: false })).errors
  assert.deepEqual(e.map((x) => x.field), ['mode', 'check', 'model', 'effort', 'onChange'])
  for (const x of e) assert.match(x.message, /is for a session rule: an act rule runs "markRead" itself and opens no session/)
  // jev, hours, limits and the rest are an act rule's as any rule's.
  assert.deepEqual(S.checkRule(actRaw({ jev: { question: 'Done?' }, hours: { from: '08:00', to: '18:00' }, limits: { perDay: 50, cooldownMinutes: 5 }, name: 'n', enabled: false })).errors, [])
  for (const m of S.MODE_LIST) assert.equal(S.checkRule(rule('a', { mode: m })).rule.mode, m)
  assert.equal(S.checkRule(rule('a')).rule.mode, 'investigate', 'no mode is investigate')
  for (const bad of ['Act', 'bypass', '', true]) assert.match(S.checkRule(rule('a', { mode: bad })).errors[0].message, /^mode must be one of investigate, act/)
  // In a file: an invalid act rule is a problem and skipped, the others keep working.
  const { rules, problems } = R.readRules([actRaw({ check: 'x' }), rule('good')])
  assert.deepEqual(rules.map((r) => r.id), ['good'])
  assert.match(problems[0], /^rule 1 \("read"\): check is for a session rule/)
})

test('canonicalRule: an act rule is written with act and no session key; mode only when it is act', () => {
  assert.deepEqual(Object.keys(S.canonicalRule({ ...actRaw(), check: 'stale', model: 'sonnet', onChange: true, mode: 'act' }, null)), ['id', 'enabled', 'sources', 'when', 'act', 'limits'])
  assert.equal(Object.hasOwn(S.canonicalRule({ ...rule('a'), mode: 'investigate' }, null), 'mode'), false, 'the default stays out of the file')
  const actMode = S.canonicalRule({ ...rule('a'), mode: 'act' }, null)
  assert.deepEqual(Object.keys(actMode).slice(0, 7), ['id', 'enabled', 'sources', 'when', 'playbook', 'mode', 'check'])
  assert.deepEqual(S.checkRule(actMode).errors, [])
})

test('hasAllowedActions: the heading at any level and case, with a list item before the next heading', () => {
  const yes = ['## Allowed actions\n- one', '# x\n\n### allowed ACTIONS:\n\n1. one', '## Allowed actions\n\n  * one\n## Next', '#### Allowed actions ##\n+ one']
  const no = ['', '- one', 'Allowed actions\n- one', '## Allowed actions\n', '## Allowed actions\nSome text.\n', '## Allowed actions\n<!-- - one -->', '## Allowed actions\n## Next\n- one', '## Allowed actions and more\n- one', '##Allowed actions\n- one', '## Allowed actions\n-one']
  for (const b of yes) assert.equal(S.hasAllowedActions(b), true, b)
  for (const b of no) assert.equal(S.hasAllowedActions(b), false, b)
})

test('loadFolder: an act rule needs no playbook; act mode without "Allowed actions" is a problem; base.md is read', async () => {
  const dir = tempFolder([actRaw(), rule('look', { mode: 'act', playbook: 'plain' }), rule('fix', { mode: 'act', playbook: 'listed' })], { plain: '# Plain\nLook.', listed: '# Listed\n\n## Allowed actions\n\n- Append one line to ~/notes/x.md.' })
  try {
    require('node:fs').writeFileSync(path.join(dir, 'base.md'), '\ufeffReport briefly.\r\n')
    const got = await R.loadFolder(dir, fsp, 'project')
    assert.deepEqual(got.rules.map((r) => r.ref), ['project:read', 'project:fix'])
    assert.deepEqual(got.problems, ['rule "look": mode "act" needs an "Allowed actions" section in playbooks/plain.md (a heading "## Allowed actions" with the actions listed under it as a Markdown list): the session may do only what is listed there; skipped'])
    assert.equal(got.entries[1].rule, null)
    assert.match(got.entries[1].problem, /^mode "act" needs/)
    assert.deepEqual(got.base, { text: 'Report briefly.', size: 20 })
    assert.equal(got.baseProblem, null)
    assert.equal(got.playbooks.has('plain'), true)
    // Empty: none. Over the cap or not a file: a problem line and no text.
    require('node:fs').writeFileSync(path.join(dir, 'base.md'), '  \n')
    assert.equal((await R.loadFolder(dir, fsp)).base, null)
    require('node:fs').writeFileSync(path.join(dir, 'base.md'), 'x'.repeat(S.MAX_BASE_BYTES + 1))
    const big = await R.loadFolder(dir, fsp)
    assert.deepEqual([big.base, big.baseProblem], [null, 'base.md: over 16 KiB'])
    assert.ok(big.problems.includes('base.md: over 16 KiB; no session opens until it is fixed'))
    require('node:fs').rmSync(path.join(dir, 'base.md'))
    require('node:fs').mkdirSync(path.join(dir, 'base.md'))
    assert.equal((await R.loadFolder(dir, fsp)).baseProblem, 'base.md: not a file')
    // A missing folder has no base.md and no extra problem.
    const gone = await R.loadFolder(path.join(dir, 'nope'), fsp)
    assert.deepEqual([gone.base, gone.baseProblem, gone.problems.length], [null, null, 1])
  } finally {
    removeFolder(dir)
  }
})

test('summaryOf: an act rule names its action, an act-mode rule says so', () => {
  const a = { ...S.checkRule(actRaw()).rule }
  assert.equal(R.summaryOf(a), 'bronos.gmail, title contains Done · runs markRead on new items (no session) · 100/day')
  assert.equal(R.summaryOf(S.checkRule(rule('a', { mode: 'act', model: 'sonnet' })).rule), 'any source, title contains down · playbook check (act mode sonnet) · 10/day, 30 min cooldown')
})

test('default limits per kind: an act rule 100 a day and no cooldown, a session rule 10 and 30 min', () => {
  assert.deepEqual(S.ACT_LIMIT_DEFAULTS, { perDay: 100, cooldownMinutes: 0 })
  assert.deepEqual(S.LIMIT_DEFAULTS, { perDay: 10, cooldownMinutes: 30 })
  assert.deepEqual(S.checkRule(actRaw()).rule.limits, S.ACT_LIMIT_DEFAULTS, 'no limits key')
  assert.deepEqual(S.checkRule(actRaw({ limits: {} })).rule.limits, S.ACT_LIMIT_DEFAULTS, 'an empty limits object')
  assert.deepEqual(S.checkRule(actRaw({ limits: { cooldownMinutes: 10 } })).rule.limits, { perDay: 100, cooldownMinutes: 10 }, 'each key on its own')
  assert.deepEqual(S.checkRule(rule('a')).rule.limits, S.LIMIT_DEFAULTS)
  assert.deepEqual(S.checkRule(rule('a', { limits: { perDay: 3 } })).rule.limits, { perDay: 3, cooldownMinutes: 30 })
  // canonicalRule writes the kind's defaults too (the panel's save).
  assert.deepEqual(S.canonicalRule(actRaw(), null).limits, S.ACT_LIMIT_DEFAULTS)
  assert.deepEqual(S.canonicalRule(rule('a'), null).limits, S.LIMIT_DEFAULTS)
})

test('the perDay cap allows 100, and cooldownMinutes 0 is no cooldown in both kinds', async () => {
  assert.ok(S.LIMITS.perDay.max >= 100)
  assert.equal(S.LIMITS.cooldownMinutes.min, 0)
  for (const raw of [actRaw({ limits: { perDay: 100 } }), rule('a', { limits: { perDay: 100 } })]) assert.deepEqual(S.checkRule(raw).errors, [])
  for (const raw of [actRaw({ limits: { perDay: 101 } }), rule('a', { limits: { perDay: 101 } })]) assert.match(S.checkRule(raw).errors[0].message, /limits.perDay must be a whole number from 1 to 100/)
  // No cooldown: a second run right after the first is not held, for a session rule as for an act rule.
  for (const r of [S.checkRule(actRaw()).rule, S.checkRule(rule('a', { limits: { cooldownMinutes: 0 } })).rule]) {
    const st = createState(fakeStorage())
    await st.load()
    await st.recordOpen(r.id, NOW, r.act ? 'act' : undefined)
    assert.equal(st.limitReason(r, NOW + 1), null, r.id)
  }
})
