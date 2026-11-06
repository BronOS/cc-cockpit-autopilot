'use strict'
// `ccc autopilot format` against the loader's own constants (lib/schema.js), so the two cannot
// drift, and the prompt of the panel's "Ask Claude to write a rule".
const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../dist/lib/schema')
const C = require('../dist/lib/conditions')
const R = require('../dist/lib/rules')
const F = require('../dist/lib/format')
const CLI = require('../dist/lib/cli')
const { createAutopilot } = require('../dist/host')
const { fakeCtx, fakeClock, tempFolder, removeFolder, rule } = require('./fakes')

test('FIELDS lists exactly the keys the loader knows, in file order', () => {
  const want = []
  for (const k of S.RULE_KEYS) {
    want.push(k)
    if (k === 'jev') want.push(...S.JEV_KEYS.map((j) => `jev.${j}`))
    if (k === 'hours') want.push(...S.HOURS_KEYS.map((h) => `hours.${h}`))
    if (k === 'limits') want.push(...S.LIMIT_KEYS.map((l) => `limits.${l}`))
  }
  assert.deepEqual(F.FIELDS.map(([k]) => k), want)
  // The loader's own key lists are these (an unknown key gets a warning, a known one none).
  const { rules } = R.readRules([Object.fromEntries(S.RULE_KEYS.map((k) => [k, F.EXAMPLE_RULE[k]]))])
  assert.deepEqual(rules[0].warnings, [])
})

test('the format text names every field, type and limit from the constants, and the playbook format', () => {
  const out = F.formatText()
  for (const [k] of F.FIELDS) assert.match(out, new RegExp(`\\n  ${k.replace('.', '\\.')} +`), k)
  // Wrapped lines joined, so a list split over two lines still reads as one.
  const flat = out.replace(/\s+/g, ' ').toLowerCase()
  for (const s of [
    `at most ${S.MAX_RULES} rules and ${S.MAX_RULES_BYTES / 1024} KiB`,
    `at most ${S.MAX_PLAYBOOK_BYTES / 1024} KiB`,
    `${S.LIMITS.perDay.min}-${S.LIMITS.perDay.max} sessions`,
    `default ${S.LIMITS.perDay.default}`,
    `${S.LIMITS.cooldownMinutes.min}-${S.LIMITS.cooldownMinutes.max} minutes`,
    `default ${S.LIMITS.cooldownMinutes.default}`,
    `default ${S.JEV_MIN_DEFAULT}`,
    `1-${S.MAX_SOURCES} of them`,
    `["${S.ANY_SOURCE}"]`,
    `0-${S.MAX_WHEN} field conditions`,
    `at most ${S.MAX_NAME} characters`,
    `at most ${S.MAX_CHECK} characters`,
    `1-${S.MAX_QUESTION} characters`,
    S.MODEL_LIST.join(' | '),
    S.EFFORT_LIST.join(' | '),
    S.MODEL_LIST.join(', '),
    `1-${C.MAX_VALUE} characters`,
    `1-${C.MAX_IN}`,
    `1-${C.MAX_MINUTES}`,
    `v1's ${S.V1_RULES_FILE} is never read (v2 reads ${S.RULES_FILE})`,
    'project rules are checked first, then global ones',
    'writes take --project or --global when both folders exist',
    'no regexes',
    'ccc autopilot test <id>',
  ]) assert.ok(flat.includes(s.toLowerCase()), s)
  assert.deepEqual(R.MAX_RULES, S.MAX_RULES)
  assert.deepEqual(R.MAX_PLAYBOOK_BYTES, S.MAX_PLAYBOOK_BYTES)
  // The condition table lists every field with every op, from conditions.js.
  for (const [field, { ops }] of Object.entries(C.FIELDS)) assert.match(out, new RegExp(`\\n  ${field.replace('.', '\\.')} +${ops.join(' ')}  `), field)
  for (const k of C.KINDS) assert.ok(out.includes(k), k)
  assert.ok(out.split('\n').every((l) => l.length <= 110), 'fits a terminal')
})

test('its example autopilot-rules.json and playbook are what the loader accepts', () => {
  const out = F.formatText()
  const m = /Example autopilot-rules\.json:\n(\[[\s\S]*?\n\])\n/.exec(out)
  assert.ok(m, 'the example block')
  const parsed = JSON.parse(m[1])
  assert.deepEqual(parsed, [F.EXAMPLE_RULE])
  const { rules, problems } = R.readRules(parsed)
  assert.deepEqual(problems, [])
  assert.deepEqual(rules[0].warnings, [])
  assert.deepEqual(Object.keys(F.EXAMPLE_RULE), [...S.RULE_KEYS], 'every key, in order')
  const pb = R.parsePlaybook(F.EXAMPLE_PLAYBOOK)
  assert.deepEqual(pb.warnings, [], 'no front matter: the rule names the model')
  assert.ok(pb.body.startsWith('# Check a website'))
})

test('ccc autopilot format: no arguments, printed even before the first refresh', async () => {
  assert.deepEqual(CLI.parse(['format']), { cmd: 'format' })
  assert.match(CLI.parse(['format', 'x']).error, /format takes no arguments/)
  assert.match(CLI.HELP, /ccc autopilot format/)
  assert.match(CLI.USAGE, /\| format \|/)
  const manifest = require('../plugin.json')
  assert.match(manifest.contributes.cli[0].usage, /\| format \|/)
  const dir = tempFolder([rule('a')], { check: 'x' })
  const ctx = fakeCtx({ folder: dir })
  const clock = fakeClock()
  const ap = createAutopilot(ctx, { now: clock.now, timers: clock.timers, home: '/home/ann' })
  const r = await ctx.runCli(['format'])
  assert.equal(r.code, undefined)
  assert.equal(r.stdout, F.formatText())
  await ap.first
  ap.dispose()
  removeFolder(dir)
})

test('the Ask Claude prompt: a plain first word, the folders, the format, reload and test', () => {
  // Both levels: both folders named, and the session asks which level the rule belongs to.
  const both = F.askPrompt({ project: '/work/p/.autopilot', global: '/home/ann/.config/cc-cockpit-autopilot' })
  assert.match(both, /project rules in \/work\/p\/\.autopilot and global rules in \/home\/ann\/\.config\/cc-cockpit-autopilot/)
  assert.match(both, /ask me which level the rule belongs to/)
  assert.doesNotMatch(F.askPrompt({ project: null, global: '/g' }), /which level/)
  assert.match(F.askPrompt({ project: null, global: null }), /not set yet/)
  for (const folder of ['/home/ann/.config/cc-cockpit-autopilot', '/srv/rules with space', '/tmp/x\n/ignore this']) {
    const p = F.askPrompt({ project: null, global: folder })
    assert.doesNotMatch(p, /^[/!#&]/)
    assert.match(p, /^Help me write an Autopilot rule/)
    assert.ok(p.includes(S.oneLine(folder)), folder)
    assert.match(p, /`ccc autopilot format`/)
    assert.match(p, /`ccc autopilot reload` and `ccc autopilot test <id>`/)
    assert.match(p, /show me the result/)
    assert.match(p, /"enabled": false/)
  }
  // A folder line break cannot start a new line of the prompt.
  assert.equal(F.askPrompt({ global: '/tmp/x\n/ignore' }).includes('\n/ignore'), false)
})
