'use strict'
// The manifest against what `ccc guide plugins` requires, and source checks: services used and
// collected (the app refuses a collected name missing from uses), the CLI, the panel, the folder
// setting with no regex in the schema, no dependency, no exec, no network, no secrets, example
// data only in the repo (the person's rules and playbooks never live here).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'))
const walkFiles = (dirs, ext) => {
  const out = []
  const walk = (d) => {
    if (!fs.existsSync(d)) return
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name)
      if (n.isDirectory()) walk(p)
      else if (ext.some((e) => n.name.endsWith(e))) out.push(p)
    }
  }
  for (const d of dirs) walk(path.join(ROOT, d))
  return out
}
const sources = () => walkFiles(['dist', 'panels'], ['.js'])
const noComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('the manifest: id, api, entry points exist, the panel', () => {
  assert.equal(manifest.id, 'bronos.autopilot')
  assert.match(manifest.id, /^[a-z0-9]+(\.[a-z0-9-]+)+$/)
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  // 0.4.0: the live Jira condition and onChange on act rules (a bump the marketplace entry and the README follow).
  assert.equal(manifest.version, '0.4.0')
  assert.equal(manifest.api, 1)
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.author, 'Oleg Bronzov')
  assert.ok(fs.existsSync(path.join(ROOT, manifest.main)))
  assert.deepEqual(Object.keys(manifest).filter((k) => !['description', 'author', 'license'].includes(k)).sort(), ['api', 'contributes', 'id', 'main', 'name', 'services', 'version'])
  const [panel] = manifest.contributes.panels
  assert.equal(manifest.contributes.panels.length, 1)
  assert.equal(panel.id, 'main')
  assert.match(panel.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  assert.ok(['left', 'right', 'bottom'].includes(panel.defaultZone))
  assert.ok(fs.existsSync(path.join(ROOT, panel.entry)))
  assert.ok(fs.existsSync(path.join(ROOT, panel.icon)))
  assert.match(manifest.description, /cc-cockpit 0\.11\.0/)
})

test('contributes.cli: one command, summary and usage within the limits, usage starting with the name', () => {
  assert.equal(manifest.contributes.cli.length, 1)
  const [cli] = manifest.contributes.cli
  assert.equal(cli.name, 'autopilot')
  assert.match(cli.name, /^[a-z][a-z0-9-]{1,31}$/)
  assert.ok(cli.summary.length <= 200)
  assert.ok(cli.usage.length <= 500)
  assert.ok(cli.usage.startsWith('autopilot'))
  // Only a `-` argument reads stdin (`rules add -`, `test -`, `playbooks set <name> -`): with stdinDash the
  // app reads it for those and never makes `ccc autopilot status` wait on a terminal.
  assert.equal(cli.stdin, true)
  assert.equal(cli.stdinDash, true)
  assert.deepEqual(Object.keys(cli).sort(), ['name', 'stdin', 'stdinDash', 'summary', 'usage'])
  // The usage names every top-level command the parser knows.
  for (const w of ['status', 'on', 'off', 'log', 'test', 'reload', 'format', 'rules', 'playbooks', 'stop', 'help']) assert.ok(cli.usage.includes(w), w)
  const CLI = require('../dist/lib/cli')
  for (const sub of [...CLI.RULES_SUBS, ...CLI.PLAYBOOKS_SUBS]) if (sub !== 'list') assert.ok(cli.usage.includes(sub), sub)
})

test('services: uses inbox-feed, jev and jira (0.4.0), collects inbox-feed (a subset of uses), provides nothing', () => {
  assert.deepEqual(manifest.services, { uses: { 'inbox-feed': 2, jev: 1, jira: 1 }, collects: ['inbox-feed'] })
  for (const name of manifest.services.collects) assert.ok(Object.hasOwn(manifest.services.uses, name), name)
  for (const name of Object.keys(manifest.services.uses)) assert.match(name, /^[a-z][a-z0-9-]{0,63}$/)
})

test('settings: the global folder (app, default ~/.config/...) and the project folder (project, empty); no regex anywhere', () => {
  const s = manifest.contributes.settings
  assert.equal(s.app.type, 'object')
  assert.deepEqual(Object.keys(s.app.properties), ['globalFolder'], 'app-scope settings are global only: just the global folder')
  const g = s.app.properties.globalFolder
  assert.equal(g.type, 'string')
  const { DEFAULT_GLOBAL_FOLDER, levelFolder } = require('../dist/lib/rules')
  assert.equal(g.default, DEFAULT_GLOBAL_FOLDER)
  assert.equal(g.default, '~/.config/cc-cockpit-autopilot')
  const p = s.project.properties.projectFolder
  assert.equal(p.type, 'string')
  assert.equal(p.default, '', 'no project rules unless the person sets a folder')
  assert.equal(Object.hasOwn(s.project.properties, 'folder'), false, 'the v1 "folder" setting is replaced')
  // The defaults the app fills in read as: global rules in the default folder, no project rules.
  assert.equal(levelFolder('global', { app: { globalFolder: g.default }, project: {} }, '/home/ann', '/w').folder, '/home/ann/.config/cc-cockpit-autopilot')
  assert.equal(levelFolder('project', { app: {}, project: { projectFolder: p.default } }, '/home/ann', '/w').folder, null)
  assert.doesNotMatch(JSON.stringify(s), /"pattern"|"patternProperties"/)
})

test('settings: maxRunning 1..10 (default 3) and myNames (at most 10 strings) match lib/runs.js', () => {
  const RUNS = require('../dist/lib/runs')
  const p = manifest.contributes.settings.project.properties
  assert.deepEqual(Object.keys(p).sort(), ['maxRunning', 'myNames', 'projectFolder'])
  const m = p.maxRunning
  assert.deepEqual([m.type, m.minimum, m.maximum, m.default], ['integer', RUNS.MAX_RUNNING.min, RUNS.MAX_RUNNING.max, RUNS.MAX_RUNNING.default])
  const n = p.myNames
  assert.deepEqual([n.type, n.maxItems, n.items.type, n.items.maxLength], ['array', RUNS.MY_NAMES_MAX, 'string', RUNS.MY_NAME_LEN])
  assert.deepEqual(n.default, [])
  // The defaults the app fills in read back as the defaults.
  assert.equal(RUNS.maxRunningOf({ project: { maxRunning: m.default } }), 3)
  assert.deepEqual(RUNS.myNamesOf({ project: { myNames: n.default } }), [])
  for (const f of Object.values(p)) assert.ok(f.title && f.description, 'every field titled and described')
})

test('no dependency, no exec, no network, no secrets or OAuth; it loads', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  for (const file of sources()) {
    const src = noComments(fs.readFileSync(file, 'utf8'))
    assert.doesNotMatch(src, /require\(['"](node:)?child_process['"]\)|ctx\.exec\(/, file)
    assert.doesNotMatch(src, /\bfetch\(|https?\.request\(/, file)
    assert.doesNotMatch(src, /ctx\.(secrets|oauth)\b/, file)
  }
  const host = require('../dist/host')
  assert.equal(typeof host.activate, 'function')
  assert.equal(typeof host.deactivate, 'function')
})

test('example data only: addresses on example domains, the examples folder valid', async () => {
  for (const file of [...sources(), ...walkFiles(['test', 'examples'], ['.js', '.json', '.md']), path.join(ROOT, 'README.md')]) {
    if (!fs.existsSync(file)) continue
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
      assert.match(m[1], /(^|\.)example\.(com|org|atlassian\.net)$|^anthropic\.com$|^gmail\.com$/, `${file}: ${m[0]}`)
    }
  }
  const R = require('../dist/lib/rules')
  const got = await R.loadFolder(path.join(ROOT, 'examples'), require('node:fs/promises'))
  assert.deepEqual(got.problems, [])
  assert.ok(got.rules.length >= 1)
})


// ---- the autopilot-rules skill: a drift guard, as Inbox's skill.test.js ----

const SKILL_DIR = 'skills/autopilot-rules'
const skill = () => fs.readFileSync(path.join(ROOT, SKILL_DIR, 'SKILL.md'), 'utf8')
const skillFix = `Update ${SKILL_DIR}/SKILL.md to match the code.`

test('the skill is declared and its front matter is the two lines the app accepts', () => {
  assert.deepEqual(manifest.contributes.skills, [{ id: 'autopilot-rules', dir: SKILL_DIR }])
  const text = skill()
  const m = /^---\nname: autopilot-rules\ndescription: ([^\n]+)\n---\n/.exec(text)
  assert.ok(m, 'front matter must be exactly name and description')
  assert.ok(m[1].length <= 1024 && !m[1].includes(': ') && !m[1].includes(' #') && !/^['"]/.test(m[1]), 'description must be a plain YAML string')
  assert.ok(!text.includes('\r'), 'no CRLF')
  assert.deepEqual(fs.readdirSync(path.join(ROOT, SKILL_DIR)), ['SKILL.md'])
})

test('the skill: the condition table is the code\'s, every field with exactly its ops', () => {
  const C = require('../dist/lib/conditions')
  const rows = new Map()
  for (const m of skill().matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/gm)) rows.set(m[1], { ops: [...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]), value: m[3] })
  assert.deepEqual([...rows.keys()].sort(), Object.keys(C.FIELDS).sort(), `the table must list exactly the fields of conditions.js FIELDS. ${skillFix}`)
  for (const [field, spec] of Object.entries(C.FIELDS)) {
    assert.deepEqual(rows.get(field).ops, spec.ops, `the ops of ${field} must be ${spec.ops.join(', ')}, in that order. ${skillFix}`)
    const v = rows.get(field).value
    if (spec.value === 'kind') for (const k of C.KINDS) assert.ok(v.includes(`\`${k}\``), `${field} must list ${k}. ${skillFix}`)
    if (spec.value === 'to') for (const k of C.TO) assert.ok(v.includes(`\`${k}\``), `${field} must list ${k}. ${skillFix}`)
    if (spec.value === 'minutes') assert.ok(v.includes(`1 to ${C.MAX_MINUTES}`), `${field} must say 1 to ${C.MAX_MINUTES}. ${skillFix}`)
  }
  assert.ok(skill().includes(`1 to ${C.MAX_VALUE} characters`), `the text value length. ${skillFix}`)
  assert.ok(skill().includes(`1 to ${C.MAX_IN} values`), `the in list length. ${skillFix}`)
})

test('the skill: the caps and values it states are the schema\'s', () => {
  const S = require('../dist/lib/schema')
  const RUNS = require('../dist/lib/runs')
  const text = skill()
  const flat = text.replace(/\s+/g, ' ')
  const must = (t, what) => assert.ok(flat.includes(t), `${SKILL_DIR}/SKILL.md must state ${what} ("${t}"). ${skillFix}`)
  must(`at most ${S.MAX_NAME} characters`, 'the name length')
  must(`at most ${S.MAX_CHECK} characters`, 'the check length')
  must(`1 to ${S.MAX_SOURCES} plugin ids`, 'the sources cap')
  must(`0 to ${S.MAX_WHEN} conditions`, 'the condition cap')
  must(`1 to ${S.MAX_QUESTION} characters`, 'the Jev question length')
  must(`at most 64 KiB`, 'the playbook size')
  assert.equal(S.MAX_PLAYBOOK_BYTES, 64 * 1024)
  must(`\`perDay\` ${S.LIMITS.perDay.min} to ${S.LIMITS.perDay.max}`, 'perDay')
  must(`(default ${S.LIMITS.perDay.default})`, 'perDay default')
  must(`\`cooldownMinutes\` ${S.LIMITS.cooldownMinutes.min} to ${S.LIMITS.cooldownMinutes.max}`, 'cooldownMinutes')
  must(`(default ${S.LIMITS.cooldownMinutes.default})`, 'cooldown default')
  must(`default ${S.JEV_MIN_DEFAULT}`, 'the Jev min default')
  must(`At most **${RUNS.DELIVERY_MAX} updates**`, 'the delivery cap')
  must(`default ${RUNS.MAX_RUNNING.default}`, 'maxRunning default')
  for (const m of S.MODEL_LIST) must(`\`${m}\``, `the model ${m}`)
  for (const e of S.EFFORT_LIST) must(`\`${e}\``, `the effort ${e}`)
  for (const k of S.RULE_KEYS) assert.ok(text.includes(`"${k}"`) || text.includes(`\`${k}\``), `the rule key ${k} must appear. ${skillFix}`)
  for (const k of S.V1_KEYS) assert.ok(text.includes(`\`${k}\``) || text.includes(`${k}.`), `the v1 key ${k} must appear. ${skillFix}`)
  assert.equal(S.ANY_SOURCE, '*')
  // The JSON examples in the skill are valid v2 rules as they stand.
  const json = /```json\n([\s\S]*?)\n```/.exec(text)[1]
  const c = S.checkRule(JSON.parse(json))
  assert.deepEqual(c.errors, [], `the example rule must pass checkRule. ${skillFix}`)
  assert.deepEqual(c.warnings, [])
  // A session rule: every key but jev and act (a rule has playbook or act, never both), in file order.
  assert.deepEqual(Object.keys(JSON.parse(json)), S.RULE_KEYS.filter((k) => k !== 'jev' && k !== 'act'), 'the example shows every key but jev and act, in file order')
  for (const m of text.matchAll(/'(\{"id":[^'\n]*\})'/g)) {
    if (m[1].includes('...')) continue // a shape in a command line, not an example
    const r = S.checkRule(JSON.parse(m[1]))
    assert.deepEqual(r.errors, [], `an inline example must pass checkRule: ${m[1]}. ${skillFix}`)
  }
})

test('the skill: every command and flag the CLI knows is shown, and the v1 mapping is the format text\'s', () => {
  const CLI = require('../dist/lib/cli')
  const text = skill()
  for (const sub of CLI.RULES_SUBS) if (sub !== 'list') assert.ok(text.includes(`ccc autopilot rules ${sub}`), `the skill must show ccc autopilot rules ${sub}. ${skillFix}`)
  for (const sub of CLI.PLAYBOOKS_SUBS) if (sub !== 'list') assert.ok(text.includes(`ccc autopilot playbooks ${sub}`), `the skill must show ccc autopilot playbooks ${sub}. ${skillFix}`)
  for (const c of ['ccc autopilot test', 'ccc autopilot reload', 'ccc autopilot format', 'ccc autopilot log', 'ccc autopilot on', 'ccc autopilot off', '--at <n>', '--jev', '--project', '--global', 'project:', 'global:', 'rules add <json|->', 'rules set <n|id> <json|->', 'playbooks set <name> <text|->', 'autopilot-rules.json']) {
    assert.ok(text.includes(c), `the skill must show ${c}. ${skillFix}`)
  }
  // The v1 -> v2 mapping: each pair `ccc autopilot format` states is a row here.
  const format = require('../dist/lib/format').formatText().replace(/\s+/g, ' ')
  for (const [v1, v2] of [['match.source', 'sources'], ['match.where', 'place.name'], ['match.from', 'from.name'], ['match.text', 'title'], ['match.level', 'no equivalent'], ['triage.jev', 'jev'], ['condition', 'check'], ['on', 'enabled']]) {
    const row = new RegExp(`^\\| \`${v1.replace('.', '\\.')}\` \\|[^\\n]*${v2}`, 'm')
    assert.match(text, row, `the mapping must have a row ${v1} -> ${v2}. ${skillFix}`)
  }
  // The v1 file is never read, in both texts; no "rewrite it" handling is left.
  assert.ok(format.includes('rules.json is never read'))
  assert.ok(text.replace(/\s+/g, ' ').includes('rules.json` is never read'), `the skill must say the v1 rules.json is never read. ${skillFix}`)
  assert.ok(!format.includes('rewrite it') && !text.includes('v1 rule: rewrite it'))
  // The warning that rules start sessions on their own, and that the person enables them.
  assert.match(text, /starts a Claude session on its own/)
  assert.match(text, /\*\*switch it on only when the person says so\*\*/)
  // The refusal the skill quotes is the host's.
  const host = fs.readFileSync(path.join(ROOT, 'dist/host.js'), 'utf8')
  assert.ok(host.includes('write it first (ccc autopilot playbooks set'), 'the host refusal the skill relies on moved')
  assert.ok(text.includes('Nothing stored:'), `the skill must quote the "Nothing stored:" prefix. ${skillFix}`)
  assert.ok(host.includes('Nothing stored:'))
})

test('0.3.0 in the manifest and the skill: base in the usage; act rule vs act mode vs investigate; the Jira-Done answer is an act rule', () => {
  const S = require('../dist/lib/schema')
  const CLI = require('../dist/lib/cli')
  const cli = manifest.contributes.cli[0]
  assert.ok(cli.usage.includes('base [show|set]'), 'the usage names base')
  assert.ok(cli.usage.length <= 500)
  const text = skill()
  const flat = text.replace(/\s+/g, ' ')
  assert.match(text, /^## Which kind of rule$/m, `the skill must say when to pick which kind. ${skillFix}`)
  for (const t of ['an **act rule**', '"mode": "act"', '## Allowed actions', 'ccc autopilot base', 'ccc autopilot base set', '16 KiB']) assert.ok(text.includes(t), `the skill must show ${t}. ${skillFix}`)
  assert.equal(S.MAX_BASE_BYTES, 16 * 1024)
  assert.ok(flat.includes('"Mark the Jira-Done notification emails read" is an **act rule**'), `the Jira-Done question must be answered with an act rule. ${skillFix}`)
  for (const sub of CLI.BASE_SUBS) assert.ok(text.includes(`ccc autopilot base ${sub}`) || (sub === 'show' && text.includes('ccc autopilot base [show]')), `the skill must show base ${sub}. ${skillFix}`)
  // The act rule example in the skill passes as it stands (the inline loop above checks it too).
  const ex = [...text.matchAll(/'(\{"id":[^'\n]*"act":[^'\n]*\})'/g)].map((m) => JSON.parse(m[1]))
  assert.ok(ex.length >= 1, `the skill must show an act rule example. ${skillFix}`)
  for (const r of ex) assert.deepEqual(S.checkRule(r).errors, [])
})

test('docs: the act-mode permission sentence the design quotes is the prompt\'s own', () => {
  const P = require('../dist/lib/prompt')
  const flat = (t) => t.replace(/^> ?/gm, '').replace(/\s+/g, ' ')
  assert.ok(flat(fs.readFileSync(path.join(ROOT, 'docs/design-v2.md'), 'utf8')).includes(P.PERMISSION.act), 'docs/design-v2.md "mode on session rules" must quote prompt.js PERMISSION.act')
})
