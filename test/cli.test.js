'use strict'
// `ccc autopilot`: parsing and exit codes, then each command through the host over fakes.
process.env.TZ = 'Europe/Berlin'
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const CLI = require('../dist/lib/cli')
const { createAutopilot } = require('../dist/host')
const { fakeCtx, fakeFeed, fakeJev, fakeClock, item, settle, drive, tempFolder, removeFolder, rule, NOW, JIRA, MAIL } = require('./fakes')

test('parse: commands, defaults, and bad arguments', () => {
  assert.deepEqual(CLI.parse([]), { cmd: 'status' })
  assert.deepEqual(CLI.parse(['help']), { cmd: 'help' })
  assert.deepEqual(CLI.parse(['log']), { cmd: 'log', n: 20 })
  assert.deepEqual(CLI.parse(['log', '5']), { cmd: 'log', n: 5 })
  assert.deepEqual(CLI.parse(['test']), { cmd: 'test', rule: null, jev: false })
  assert.deepEqual(CLI.parse(['test', 'down', '--jev']), { cmd: 'test', rule: 'down', jev: true })
  assert.deepEqual(CLI.parse(['test', '--jev']), { cmd: 'test', rule: null, jev: true })
  assert.deepEqual(CLI.parse(['stop', 'r0123456789ab']), { cmd: 'stop', run: 'r0123456789ab' })
  for (const bad of [['stop'], ['stop', 'a', 'b'], ['stop', 'r 1'], ['stop', '$(x)'], ['stop', 'x'.repeat(65)], ['nope'], ['on', 'now'], ['log', '0'], ['log', '201'], ['log', 'x'], ['log', '1', '2'], ['test', 'a', 'b'], ['test', '--fast'], ['test', '--jev', '--jev'], ['status', 'x']]) {
    const p = CLI.parse(bad)
    assert.ok(p.error, bad.join(' '))
    assert.match(p.error, /Usage: ccc autopilot/)
  }
})

test('output is one line per entry, control characters out', () => {
  const line = CLI.entryLine({ at: NOW, rule: 'down', source: 'bronos.jira', itemId: 'SUP-1', title: 'a\nb\u001b[31m', step: 'jev', score: 0.912, tabId: 'tab-1' })
  assert.equal(line, '2026-11-03 13:42 down bronos.jira SUP-1 "a b [31m": opened tab tab-1 (jev 0.91)')
  assert.equal(CLI.entryLine({ at: NOW, rule: 'down', source: 'p.x', itemId: 'i', title: 't', step: 'limit', skip: 'cooldown' }), '2026-11-03 13:42 down p.x i "t": skipped (limit): cooldown')
  assert.equal(CLI.entryLine({ at: NOW, step: 'switch', note: 'Autopilot switched off' }), '2026-11-03 13:42 Autopilot switched off')
})

async function setup(rules, o = {}) {
  const dir = tempFolder(rules, { check: 'Check it.' })
  const ctx = fakeCtx({ folder: dir, jev: o.jev })
  const clock = fakeClock()
  for (const [id, f] of Object.entries(o.feeds || {})) ctx.addProvider(id, f)
  const ap = createAutopilot(ctx, { now: clock.now, timers: clock.timers, home: '/home/ann' })
  await ap.first
  return { ctx, ap, clock, dir, done: () => (ap.dispose(), removeFolder(dir)) }
}

test('status: off, the folder, rules with warnings, problems, sources, last runs', async () => {
  const jira = fakeFeed(JIRA, [item('SUP-1', { title: 'site down' })])
  const t = await setup([rule('down'), rule('broken', { playbook: '../x' }), rule('mail', { sources: ['bronos.gmail'], when: [{ field: 'title', op: 'contains', value: 'x' }], enabled: false })], { feeds: { 'bronos.jira': jira, 'bronos.gmail': fakeFeed(MAIL, []) } })
  assert.equal(t.ctx.cliName, 'autopilot')
  const r = await t.ctx.runCli([])
  assert.equal(r.code, undefined)
  const out = r.stdout
  assert.match(out, /^Autopilot: off \(nothing fires; ccc autopilot on to start\)\n/)
  assert.match(out, /\nProject rules: \/.*autopilot-test-/)
  assert.match(out, /\nGlobal rules: none \(the app setting "Global rules folder" is empty\)\n/)
  assert.match(out, /\nRules: 2 valid \(2 project\), 1 on, 1 problem; project rules are checked first\n/)
  assert.match(out, /\n {2}! project: rule 2 \("broken"\): playbook must be a file name.*skipped\n/)
  assert.match(out, /\n {2}• project:down: any source, title contains down · playbook check · 10\/day, 30 min cooldown\n {6}⚠ outsiders can trigger this rule: its sources are any source/)
  assert.match(out, /\n {2}- project:mail \(off\): bronos.gmail, title contains x/)
  assert.match(out, /\nSources: Jira, Mail\n/)
  assert.match(out, /\nNo runs yet.\n$/)
  t.done()
})

test('on, off, log, reload: the switch, the baseline line and exit 0', async () => {
  const jira = fakeFeed(JIRA, [item('SUP-1', { title: 'site down' })])
  const t = await setup([rule('down')], { feeds: { 'bronos.jira': jira } })
  const on = await t.ctx.runCli(['on'])
  assert.equal(on.stdout, 'Autopilot is on. Baseline: 1 item in the feeds now will not fire; new or changed ones will.\n')
  assert.equal(t.ap.state.enabled(), true)
  assert.equal(t.ctx.opened.length, 0)
  assert.match((await t.ctx.runCli(['status'])).stdout, /^Autopilot: on\n[\s\S]*Last runs:\n {2}2026-11-03 \d\d:\d\d Autopilot switched on/)
  const off = await t.ctx.runCli(['off'])
  assert.match(off.stdout, /^Autopilot is off/)
  assert.equal(t.ap.state.enabled(), false)
  const log = await t.ctx.runCli(['log', '1'])
  assert.match(log.stdout, /^\d{4}-\d\d-\d\d \d\d:\d\d Autopilot switched off\n$/)
  assert.match((await t.ctx.runCli(['reload'])).stdout, /: 1 valid rule, no problem\.\n/)
  t.done()
})

test('test: the dry run text; an unknown rule is exit 1; bad arguments exit 2; help', async () => {
  const jev = fakeJev(0.8)
  const jira = fakeFeed(JIRA, [item('SUP-1', { title: 'site down' }), item('SUP-2', { title: 'all good' })])
  // First rule wins: the Jev rule comes first, so the plain one waits for its answer.
  const t = await setup([rule('asked', { jev: { question: 'q?' } }), rule('down')], { jev, feeds: { 'bronos.jira': jira } })
  const r = await t.ctx.runCli(['test'])
  assert.equal(r.code, undefined)
  assert.match(r.stdout, /^Dry run over 2 items from 1 source, 2 rules \(Jev not asked: add --jev\)\. No session is started\.\n/)
  assert.match(r.stdout, /Autopilot is off: even a "would fire" opens nothing/)
  assert.match(r.stdout, /\nproject:asked {2}bronos.jira SUP-1 "site down"\n {4}would not fire: the Jev step was not asked \(would need ≥ 0.7; add --jev\); no lower rule fires until it answers/)
  assert.match(r.stdout, /\nproject:down {2}bronos.jira SUP-1 "site down"\n {4}would not fire: waits for the Jev answer of project:asked, which comes first \(matched any source, title contains down\)\n/)
  assert.equal(jev.calls.length, 0)
  const j = await drive(t.clock, t.ctx.runCli(['test', 'asked', '--jev']))
  assert.match(j.stdout, /would fire: jev 0.80, it would open a session/)
  assert.doesNotMatch(j.stdout, /\nproject:down /, 'only the tested rule')
  assert.equal(jev.calls.length, 1)
  assert.equal(t.ctx.opened.length, 0)
  // The answer is cached now: the plain run shows it, and down as also matched.
  const again = await t.ctx.runCli(['test'])
  assert.match(again.stdout, /\nproject:down {2}bronos.jira SUP-1 "site down"\n {4}would not fire: also matched: project:asked comes first and takes the item/)
  assert.equal(jev.calls.length, 1)
  const none = await t.ctx.runCli(['test', 'nope'])
  assert.equal(none.code, 1)
  assert.match(none.stderr, /No rule "nope"/)
  const bad = await t.ctx.runCli(['log', 'lots'])
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /log takes a number from 1 to 200/)
  assert.equal((await t.ctx.runCli(['frobnicate'])).code, 2)
  const help = await t.ctx.runCli(['help'])
  assert.match(help.stdout, /^ccc autopilot: start a Claude session/)
  assert.equal(help.code, undefined)
  t.done()
})

test('test on a rule with a problem says so', async () => {
  const t = await setup([rule('bad', { playbook: '../x' })])
  const r = await t.ctx.runCli(['test', 'bad'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /has a problem and is skipped/)
  await settle()
  t.done()
})

// ---- rules, playbooks and test <json> (v2) ----

test('parse: rules, playbooks and test with JSON; bad arguments are usage errors', () => {
  assert.deepEqual(CLI.parse(['rules']), { cmd: 'rules', sub: 'list' })
  assert.deepEqual(CLI.parse(['rules', 'export']), { cmd: 'rules', sub: 'export' })
  assert.deepEqual(CLI.parse(['rules', 'add', '{"id":"a"}']), { cmd: 'rules', sub: 'add', input: { text: '{"id":"a"}' }, at: null })
  assert.deepEqual(CLI.parse(['rules', 'add', '--at', '2', '-']), { cmd: 'rules', sub: 'add', input: { stdin: true }, at: 2 })
  assert.deepEqual(CLI.parse(['rules', 'set', '3', '-']), { cmd: 'rules', sub: 'set', sel: '3', input: { stdin: true } })
  assert.deepEqual(CLI.parse(['rules', 'rm', 'down']), { cmd: 'rules', sub: 'rm', sel: 'down' })
  assert.deepEqual(CLI.parse(['rules', 'move', 'down', '1']), { cmd: 'rules', sub: 'move', sel: 'down', to: 1 })
  assert.deepEqual(CLI.parse(['rules', 'enable', '2']), { cmd: 'rules', sub: 'enable', sel: '2' })
  assert.deepEqual(CLI.parse(['rules', 'disable', '2']), { cmd: 'rules', sub: 'disable', sel: '2' })
  assert.deepEqual(CLI.parse(['playbooks']), { cmd: 'playbooks', sub: 'list' })
  assert.deepEqual(CLI.parse(['playbooks', 'show', 'check']), { cmd: 'playbooks', sub: 'show', name: 'check' })
  assert.deepEqual(CLI.parse(['playbooks', 'set', 'check', '-']), { cmd: 'playbooks', sub: 'set', name: 'check', input: { stdin: true } })
  assert.deepEqual(CLI.parse(['test', '-', '--at', '2']), { cmd: 'test', rule: null, jev: false, input: { stdin: true }, at: 2 })
  assert.deepEqual(CLI.parse(['test', '{"id":"a"}', '--jev']), { cmd: 'test', rule: null, jev: true, input: { text: '{"id":"a"}' } })
  for (const bad of [['rules', 'frob'], ['rules', 'export', 'x'], ['rules', 'add'], ['rules', 'add', 'a', 'b'], ['rules', 'add', '{}', '--at'], ['rules', 'add', '{}', '--at', '0'], ['rules', 'add', '{}', '--at', 'x'], ['rules', 'set', '1'], ['rules', 'set', '-x', '{}'], ['rules', 'rm'], ['rules', 'rm', '-'], ['rules', 'move', 'a'], ['rules', 'move', 'a', '0'], ['rules', 'enable', 'a', 'b'], ['rules', 'rm', '1', '--at', '2'], ['playbooks', 'frob'], ['playbooks', 'show'], ['playbooks', 'show', '../x'], ['playbooks', 'show', 'a.b'], ['playbooks', 'set', 'a'], ['playbooks', 'rm', 'a/b'], ['playbooks', 'x'], ['test', '-', 'a'], ['test', 'a', '{}'], ['test', 'a', '--at', '1'], ['test', '-', '--at', 'x']]) {
    const p = CLI.parse(bad)
    assert.ok(p.error, bad.join(' '))
    assert.match(p.error, /Usage: ccc autopilot/)
  }
})

test('jsonInput: the argument, or stdin for -; bad JSON and non-objects are errors', () => {
  assert.deepEqual(CLI.jsonInput({ text: '{"a":1}' }, 'ignored'), { value: { a: 1 } })
  assert.deepEqual(CLI.jsonInput({ stdin: true }, '﻿{"a":2}\n'), { value: { a: 2 } })
  assert.match(CLI.jsonInput({ stdin: true }, '').error, /nothing on stdin/)
  assert.match(CLI.jsonInput({ stdin: true }, undefined).error, /nothing on stdin/)
  assert.match(CLI.jsonInput({ text: '{"a":' }, '').error, /not valid JSON/)
  assert.match(CLI.jsonInput({ text: '[1]' }, '').error, /one JSON object/)
})

const J = (o) => JSON.stringify(o)
const newRule = (id, o = {}) => ({ id, sources: ['bronos.jira'], when: [{ field: 'title', op: 'contains', value: 'down' }], playbook: 'check', ...o })
const fileOf = (t) => fs.readFileSync(path.join(t.dir, 'autopilot-rules.json'), 'utf8')
const listOf = (t) => JSON.parse(fileOf(t))

test('rules: the numbered list shows valid, off and invalid entries (a v1 entry is just invalid); export is the file', async () => {
  const t = await setup([rule('down'), rule('mail', { enabled: false }), { id: 'old', match: { source: 'bronos.jira' }, triage: {} }, rule('broken', { playbook: '../x' })])
  const r = await t.ctx.runCli(['rules'])
  assert.equal(r.code, undefined)
  assert.match(r.stdout, /^Project rules in \/.*: 4 entries in autopilot-rules.json, numbered as in the file\n/)
  assert.match(r.stdout, /\n {2}1 • project:down: any source, title contains down/)
  assert.match(r.stdout, /\n {2}2 - project:mail \(off\): /)
  assert.match(r.stdout, /\n {2}3 ! project:old: sources is missing: .*\("match" is a v1 key; v2 rules use sources, when and jev .*\) \(does not run\)\n/)
  assert.doesNotMatch(r.stdout, /rewrite it/)
  assert.match(r.stdout, /\n {2}4 ! project:broken: playbook must be a file name.* \(does not run\)\n/)
  assert.match(r.stdout, /\nGlobal rules: none \(the app setting "Global rules folder" is empty\)\nAutopilot is off; project rules are checked first, then global ones\.\n$/)
  // One level: its file as it is; no level: an object by level, null for a level with no file.
  const x = await t.ctx.runCli(['rules', 'export', '--project'])
  assert.deepEqual(JSON.parse(x.stdout), listOf(t))
  const both = await t.ctx.runCli(['rules', 'export'])
  assert.deepEqual(JSON.parse(both.stdout), { project: listOf(t), global: null })
  assert.equal((await t.ctx.runCli(['rules', 'export', '--global'])).code, 1)
  t.done()
})

test('rules add: stored off with a minted id, in place with --at, by argument or stdin; other entries untouched', async () => {
  const jira = fakeFeed(JIRA, [item('SUP-1', { title: 'site down' })])
  const junk = { id: 'bad', sources: 'nope', extra: [1, 2] }
  const t = await setup([rule('down'), junk], { feeds: { 'bronos.jira': jira } })
  // No `-`: the argument is used and stdin (which the app would not have read) is ignored.
  const a = await t.ctx.runCli(['rules', 'add', J({ sources: ['bronos.jira'], when: [{ field: 'title', op: 'contains', value: 'x' }], playbook: 'check' })], undefined, 'garbage')
  assert.equal(a.code, undefined)
  assert.match(a.stdout, /^Added to the project rules\. Rule project:r1 \(project rule 3\) is off: bronos.jira, title contains x · playbook check · 10\/day, 30 min cooldown\nAutopilot is off: nothing fires until ccc autopilot on\.\n$/)
  assert.deepEqual(listOf(t).map((e) => e.id), ['down', 'bad', 'r1'])
  assert.equal(listOf(t)[2].enabled, false)
  assert.deepEqual(listOf(t)[1], junk, 'an invalid entry is written back as it was')
  // `-` reads stdin; --at puts it first; enabled:true is kept when given.
  const b = await t.ctx.runCli(['rules', 'add', '-', '--at', '1'], undefined, J(newRule('first', { enabled: true })))
  assert.match(b.stdout, /^Added to the project rules\. Rule project:first \(project rule 1\) is on: /)
  assert.deepEqual(listOf(t).map((e) => e.id), ['first', 'down', 'bad', 'r1'])
  // The next minted id skips the used one.
  await t.ctx.runCli(['rules', 'add', J({ ...newRule('x'), id: undefined })])
  assert.equal(listOf(t)[4].id, 'r2')
  // The host reads the file again: the panel state has the rule.
  assert.ok(t.ctx.lastState().rules.some((r) => r.id === 'first'))
  assert.equal(t.ctx.opened.length, 0)
  t.done()
})

test('rules add: refusals store nothing and name the problem (exit 1), bad input is exit 2', async () => {
  const t = await setup([rule('down')])
  const before = fileOf(t)
  const run = (...a) => t.ctx.runCli(['rules', 'add', ...a])
  const noSources = await run(J({ id: 'a', playbook: 'check', when: [{ field: 'title', op: 'contains', value: 'x' }] }))
  assert.equal(noSources.code, 1)
  assert.match(noSources.stderr, /^Nothing stored: the rule is not valid: sources is missing: choose the sources/)
  const noBook = await run(J(newRule('a', { playbook: 'missing' })))
  assert.equal(noBook.code, 1)
  assert.match(noBook.stderr, /Nothing stored: playbook missing not found in .*\(the project folder, where this rule's playbook resolves\): write it first \(ccc autopilot playbooks set --project missing -\)/)
  const dup = await run(J(newRule('down')))
  assert.equal(dup.code, 1)
  assert.match(dup.stderr, /id "down" is used by another rule/)
  // A v1 entry is just an invalid rule; its first problem names the v1 key.
  const v1 = await run(J({ id: 'a', match: {} }))
  assert.equal(v1.code, 1)
  assert.match(v1.stderr, /sources is missing: .*\("match" is a v1 key; v2 rules use sources, when and jev/)
  const several = await run(J({ id: 'a', sources: [], playbook: 'check', model: 'gpt', effort: 'wild' }))
  assert.equal(several.code, 1)
  assert.match(several.stderr, /sources[\s\S]*model must be one of[\s\S]*effort must be one of/)
  const syntax = await run('{"id":')
  assert.equal(syntax.code, 2)
  assert.match(syntax.stderr, /not valid JSON/)
  const empty = await run('-')
  assert.equal(empty.code, 2)
  assert.match(empty.stderr, /nothing on stdin/)
  const arr = await run('[]')
  assert.equal(arr.code, 2)
  const at = await run(J(newRule('a')), '--at', '5')
  assert.equal(at.code, 1)
  assert.match(at.stderr, /--at 5: autopilot-rules.json has 1 entry, so the place is 1 to 2/)
  assert.equal(fileOf(t), before, 'nothing was written')
  t.done()
})

test('rules add: a file that is not a JSON list is never rewritten; a missing folder file says so', async () => {
  const t = await setup('{"not": "a list"}')
  const r = await t.ctx.runCli(['rules', 'add', J(newRule('a'))])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Nothing stored: autopilot-rules.json is not a JSON list of rules/)
  assert.equal(fileOf(t), '{"not": "a list"}')
  fs.rmSync(path.join(t.dir, 'autopilot-rules.json'))
  // A missing file is not a broken one: the add makes it (the playbook exists).
  const m = await t.ctx.runCli(['rules', 'add', J(newRule('a'))])
  assert.equal(m.code, undefined, m.stderr)
  assert.deepEqual(listOf(t).map((x) => x.id), ['a'])
  fs.rmSync(path.join(t.dir, 'autopilot-rules.json'))
  assert.equal((await t.ctx.runCli(['rules', 'export'])).code, 1, 'neither level has a readable file')
  t.done()
})

test('rules set: replaced by position or id, keeping id and on/off; unknown keys, v1 ones too, stay and are warned about', async () => {
  const t = await setup([rule('down', { enabled: false, name: 'old name' }), { id: 'old', match: { source: 'bronos.jira' }, triage: { jev: 'q' } }])
  const a = await t.ctx.runCli(['rules', 'set', '1', '-'], undefined, J({ sources: ['bronos.chat'], when: [{ field: 'mentionsMe', op: 'is', value: true }], playbook: 'check' }))
  assert.match(a.stdout, /^Replaced in the project rules\. Rule project:down \(project rule 1\) is off: bronos.chat, mentionsMe is true /)
  assert.deepEqual(Object.keys(listOf(t)[0]).slice(0, 3), ['id', 'enabled', 'sources'])
  assert.equal(listOf(t)[0].id, 'down')
  assert.equal(listOf(t)[0].name, undefined, 'a key the JSON leaves out goes back to its default')
  // A v1 entry pasted into the file is no special case: its match/triage stay as unknown keys (a save
  // never drops something silently) and the answer names them as v1 keys, so the person removes them.
  const b = await t.ctx.runCli(['rules', 'set', 'old', J(newRule('old', { enabled: false }))])
  assert.match(b.stdout, /^Replaced in the project rules\. Rule project:old \(project rule 2\) is off/)
  assert.deepEqual(listOf(t)[1].match, { source: 'bronos.jira' })
  assert.match(b.stdout, /unknown key "match" ignored: a v1 key/)
  // An id change is allowed when unique; a clash and a bad selector are refused.
  const c = await t.ctx.runCli(['rules', 'set', '2', J(newRule('renamed'))])
  assert.match(c.stdout, /^Replaced in the project rules\. Rule project:renamed \(project rule 2\) is off/)
  assert.equal(listOf(t)[1].id, 'renamed')
  const d = await t.ctx.runCli(['rules', 'set', '2', J(newRule('down'))])
  assert.equal(d.code, 1)
  assert.match(d.stderr, /used by another rule/)
  const e = await t.ctx.runCli(['rules', 'set', '9', J(newRule('z'))])
  assert.equal(e.code, 1)
  assert.match(e.stderr, /no rule 9: autopilot-rules.json has 2 entries/)
  const f = await t.ctx.runCli(['rules', 'set', 'ghost', J(newRule('z'))])
  assert.match(f.stderr, /no rule with id "ghost"/)
  assert.equal(listOf(t).length, 2)
  t.done()
})

test('rules enable, disable, move, rm: by id or position', async () => {
  const t = await setup([rule('a'), rule('b', { enabled: false }), rule('c')])
  const en = await t.ctx.runCli(['rules', 'enable', 'b'])
  assert.match(en.stdout, /^Switched on\. Rule project:b \(project rule 2\) is on: /)
  assert.equal(listOf(t)[1].enabled, true)
  const dis = await t.ctx.runCli(['rules', 'disable', '3'])
  assert.match(dis.stdout, /^Switched off\. Rule project:c \(project rule 3\) is off: /)
  const mv = await t.ctx.runCli(['rules', 'move', 'c', '1'])
  assert.match(mv.stdout, /^Moved\. Rule project:c \(project rule 1\) is off: /)
  assert.deepEqual(listOf(t).map((e) => e.id), ['c', 'a', 'b'])
  const bad = await t.ctx.runCli(['rules', 'move', 'a', '4'])
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /the place is 1 to 3/)
  const rm = await t.ctx.runCli(['rules', 'rm', '2'])
  assert.match(rm.stdout, /^Removed project rule 2\. /)
  assert.deepEqual(listOf(t).map((e) => e.id), ['c', 'b'])
  assert.equal((await t.ctx.runCli(['rules', 'rm', 'a'])).code, 1)
  assert.equal((await t.ctx.runCli(['rules', 'enable', '7'])).code, 1)
  // A v1 entry is an invalid rule like any other: a toggle writes `enabled` and keeps the rest.
  fs.writeFileSync(path.join(t.dir, 'autopilot-rules.json'), J([{ id: 'old', match: {} }]))
  const v1 = await t.ctx.runCli(['rules', 'enable', 'old'])
  assert.equal(v1.code, undefined)
  assert.deepEqual(listOf(t), [{ id: 'old', enabled: true, match: {} }])
  // The switch is on: no "Autopilot is off" line after an edit.
  fs.writeFileSync(path.join(t.dir, 'autopilot-rules.json'), J([rule('a', { enabled: false })]))
  await t.ctx.runCli(['on'])
  assert.doesNotMatch((await t.ctx.runCli(['rules', 'enable', 'a'])).stdout, /Autopilot is off/)
  t.done()
})

test('rules add: an unknown key is not stored and the answer says so', async () => {
  const t = await setup([rule('a')])
  const r = await t.ctx.runCli(['rules', 'add', J(newRule('typo', { txt: 'x' }))])
  assert.match(r.stdout, /\n  ⚠ unknown key "txt" ignored \(not stored\)\n/)
  assert.equal(listOf(t)[1].txt, undefined)
  t.done()
})

test('playbooks: list, show, set (create, replace, stdin), rm (refused while a rule names it)', async () => {
  const t = await setup([rule('down')])
  const list = await t.ctx.runCli(['playbooks'])
  assert.match(list.stdout, /^Project playbooks in .*\/playbooks:\n {2}check {2}\d+ bytes, used by down\nGlobal rules: none \(the app setting "Global rules folder" is empty\)\n$/)
  assert.equal((await t.ctx.runCli(['playbooks', 'show', 'check'])).stdout, 'Check it.\n')
  const mk = await t.ctx.runCli(['playbooks', 'set', 'deploy', '-'], undefined, '# Deploy\r\n\r\nLook at the log.   \n\n')
  assert.match(mk.stdout, /^Created playbooks\/deploy\.md in /)
  assert.equal(fs.readFileSync(path.join(t.dir, 'playbooks', 'deploy.md'), 'utf8'), '# Deploy\n\nLook at the log.\n')
  const rep = await t.ctx.runCli(['playbooks', 'set', 'deploy', '# Deploy v2'])
  assert.match(rep.stdout, /^Replaced playbooks\/deploy\.md/)
  assert.equal(fs.readFileSync(path.join(t.dir, 'playbooks', 'deploy.md'), 'utf8'), '# Deploy v2\n')
  // The rule that names it can now be added.
  assert.match((await t.ctx.runCli(['rules', 'add', J(newRule('d', { playbook: 'deploy' }))])).stdout, /^Added to the project rules\./)
  const used = await t.ctx.runCli(['playbooks', 'rm', 'deploy'])
  assert.equal(used.code, 1)
  assert.match(used.stderr, /Nothing stored: playbook deploy is used by: d/)
  await t.ctx.runCli(['rules', 'rm', 'd'])
  assert.match((await t.ctx.runCli(['playbooks', 'rm', 'deploy'])).stdout, /^Deleted playbooks\/deploy\.md/)
  assert.equal(fs.existsSync(path.join(t.dir, 'playbooks', 'deploy.md')), false)
  const none = await t.ctx.runCli(['playbooks', 'show', 'nope'])
  assert.equal(none.code, 1)
  assert.match(none.stderr, /not found/)
  const empty = await t.ctx.runCli(['playbooks', 'set', 'x', '-'])
  assert.equal(empty.code, 2)
  const blank = await t.ctx.runCli(['playbooks', 'set', 'x', '   '])
  assert.equal(blank.code, 1)
  assert.match(blank.stderr, /the playbook is empty/)
  t.done()
})

test('test <json>: a rule that is not stored is tried as on; an id of a stored rule replaces it; stdin for -', async () => {
  const jira = fakeFeed(JIRA, [item('SUP-1', { title: 'site down' }), item('SUP-2', { title: 'all good' })])
  const t = await setup([rule('down', { sources: ['bronos.chat'] })], { feeds: { 'bronos.jira': jira } })
  const before = fileOf(t)
  // A new rule (written off, tested as on), first in the list: it takes SUP-1.
  const a = await t.ctx.runCli(['test', J(newRule('try', { enabled: false })), '--at', '1'])
  assert.equal(a.code, undefined)
  assert.match(a.stdout, /Dry run over 2 items from 1 source, 1 rule/)
  assert.match(a.stdout, /\nRule project:try is the JSON you gave, not stored: tested as on, at position 1 of its level's file\.\n/)
  assert.match(a.stdout, /\nproject:try {2}bronos.jira SUP-1 "site down"\n {4}would fire: it would open a session \(matched source bronos.jira, title contains down\)\n/)
  assert.doesNotMatch(a.stdout, /SUP-2/)
  // The same id as a stored rule: the edit is tried in its place (here moved from Chat to Jira).
  const b = await t.ctx.runCli(['test', '-'], undefined, J(newRule('down')))
  assert.match(b.stdout, /in the place of the stored rule project:down\./)
  assert.match(b.stdout, /\nproject:down {2}bronos.jira SUP-1 "site down"\n {4}would fire/)
  // No id needed.
  const c = await t.ctx.runCli(['test', J({ sources: ['*'], when: [{ field: 'title', op: 'contains', value: 'good' }], playbook: 'check' })])
  assert.match(c.stdout, /\nproject:candidate {2}bronos.jira SUP-2 "all good"\n/)
  // Refusals: invalid rule (1), missing playbook (1), bad JSON (2); nothing was ever written.
  const d = await t.ctx.runCli(['test', J({ id: 'z', playbook: 'check' })])
  assert.equal(d.code, 1)
  assert.match(d.stderr, /sources is missing/)
  const e = await t.ctx.runCli(['test', J(newRule('z', { playbook: 'nope' }))])
  assert.equal(e.code, 1)
  assert.match(e.stderr, /playbook nope not found/)
  const f = await t.ctx.runCli(['test', '{'])
  assert.equal(f.code, 2)
  assert.equal(t.ctx.opened.length, 0)
  assert.equal(fileOf(t), before)
  t.done()
})

// ---- two levels: project rules first, then global; writes name the level when both folders exist ----

test('parse: --project / --global and level:id selectors; a clash or a doubled flag is a usage error', () => {
  assert.deepEqual(CLI.parse(['rules', '--global']), { cmd: 'rules', sub: 'list', level: 'global' })
  assert.deepEqual(CLI.parse(['rules', 'export', '--project']), { cmd: 'rules', sub: 'export', level: 'project' })
  assert.deepEqual(CLI.parse(['rules', 'add', '--global', '{}']), { cmd: 'rules', sub: 'add', level: 'global', input: { text: '{}' }, at: null })
  assert.deepEqual(CLI.parse(['rules', 'enable', 'global:a']), { cmd: 'rules', sub: 'enable', level: 'global', sel: 'a' })
  assert.deepEqual(CLI.parse(['rules', 'set', 'project:2', '-']), { cmd: 'rules', sub: 'set', level: 'project', sel: '2', input: { stdin: true } })
  assert.deepEqual(CLI.parse(['playbooks', 'set', '--project', 'x', '-']), { cmd: 'playbooks', sub: 'set', level: 'project', name: 'x', input: { stdin: true } })
  assert.deepEqual(CLI.parse(['test', '-', '--global', '--at', '2']), { cmd: 'test', rule: null, jev: false, level: 'global', input: { stdin: true }, at: 2 })
  for (const bad of [['rules', '--project', '--global'], ['rules', '--global', '--global'], ['rules', 'enable', '--project', 'global:a'], ['rules', 'enable', 'other:a'], ['playbooks', 'rm', 'global:x'], ['log', '--global']]) {
    const p = CLI.parse(bad)
    assert.ok(p.error, bad.join(' '))
    assert.match(p.error, /Usage: ccc autopilot/)
  }
})

async function setupBoth(projectRules, globalRules, o = {}) {
  const dir = tempFolder(projectRules, { check: 'Project check.', ...(o.projectBooks || {}) })
  const gdir = tempFolder(globalRules, { check: 'Global check.', ...(o.globalBooks || {}) }, o.v1)
  const ctx = fakeCtx({ folder: dir, globalFolder: gdir })
  const clock = fakeClock()
  for (const [id, f] of Object.entries(o.feeds || {})) ctx.addProvider(id, f)
  const ap = createAutopilot(ctx, { now: clock.now, timers: clock.timers, home: '/home/ann' })
  await ap.first
  const read = (d) => JSON.parse(fs.readFileSync(path.join(d, 'autopilot-rules.json'), 'utf8'))
  return { ctx, ap, clock, dir, gdir, project: () => read(dir), global: () => read(gdir), done: () => (ap.dispose(), removeFolder(dir), removeFolder(gdir)) }
}

test('two levels: status and rules show both, named project:<id> / global:<id>; project rules are tried first', async () => {
  const jira = fakeFeed(JIRA, [item('SUP-1', { title: 'site down' })])
  const t = await setupBoth([rule('down')], [rule('down'), rule('lead', { sources: ['bronos.jira'] })], { feeds: { 'bronos.jira': jira } })
  const st = (await t.ctx.runCli([])).stdout
  assert.match(st, /\nProject rules: \/.*autopilot-test-.*\nGlobal rules: \/.*autopilot-test-/)
  assert.match(st, /\nRules: 3 valid \(1 project, 2 global\), 3 on; project rules are checked first\n/)
  assert.match(st, /\n {2}• project:down: [\s\S]*\n {2}• global:down: [\s\S]*\n {2}• global:lead: /)
  const list = (await t.ctx.runCli(['rules'])).stdout
  assert.match(list, /^Project rules in .*: 1 entry in autopilot-rules.json, numbered as in the file\n {2}1 • project:down: /)
  assert.match(list, /\nGlobal rules in .*: 2 entries in autopilot-rules.json, numbered as in the file\n {2}1 • global:down: [\s\S]*\n {2}2 • global:lead: /)
  assert.doesNotMatch((await t.ctx.runCli(['rules', '--global'])).stdout, /project:down/)
  assert.deepEqual(JSON.parse((await t.ctx.runCli(['rules', 'export'])).stdout), { project: t.project(), global: t.global() })
  // The same id at both levels: the project rule takes the item, the global one only "also matched".
  const dry = (await t.ctx.runCli(['test'])).stdout
  assert.match(dry, /\nproject:down {2}bronos.jira SUP-1 "site down"\n {4}would fire: /)
  assert.match(dry, /\nglobal:down {2}bronos.jira SUP-1 "site down"\n {4}would not fire: also matched: project:down comes first/)
  // A bare id both levels have is ambiguous for test; the qualified one is not.
  const amb = await t.ctx.runCli(['test', 'down'])
  assert.equal(amb.code, 1)
  assert.match(amb.stderr, /project:down.*global:down|both levels/)
  assert.match((await t.ctx.runCli(['test', 'global:down'])).stdout, /\nglobal:down {2}bronos.jira SUP-1/)
  assert.match((await t.ctx.runCli(['test', 'lead'])).stdout, /\nglobal:lead {2}/, 'an id only one level has needs no level')
  t.done()
})

test('two levels: a write without a level stores nothing (exit 2); with one, only that file changes', async () => {
  const t = await setupBoth([rule('down')], [rule('mail')])
  const p0 = JSON.stringify(t.project())
  const g0 = JSON.stringify(t.global())
  for (const args of [['rules', 'add', J(newRule('x'))], ['rules', 'enable', 'down'], ['rules', 'rm', '1'], ['playbooks', 'set', 'deploy', '# D'], ['playbooks', 'rm', 'check']]) {
    const r = await t.ctx.runCli(args)
    assert.equal(r.code, 2, args.join(' '))
    assert.match(r.stderr, /Both rule levels have a folder: add --project \(this project only\) or --global \(every project\)/)
  }
  assert.equal(JSON.stringify(t.project()), p0)
  assert.equal(JSON.stringify(t.global()), g0)
  assert.equal(fs.existsSync(path.join(t.dir, 'playbooks', 'deploy.md')), false)
  // --global: the global file only; the playbook is checked in the global folder.
  const g = await t.ctx.runCli(['rules', 'add', '--global', J(newRule('down'))])
  assert.match(g.stdout, /^Added to the global rules\. Rule global:down \(global rule 2\) is off: /, 'an id the other level has is fine')
  assert.deepEqual(t.global().map((e) => e.id), ['mail', 'down'])
  assert.equal(JSON.stringify(t.project()), p0)
  // A qualified selector names the level as well as a flag does.
  assert.match((await t.ctx.runCli(['rules', 'enable', 'global:down'])).stdout, /^Switched on\. Rule global:down \(global rule 2\) is on/)
  assert.equal(t.global()[1].enabled, true)
  assert.equal(JSON.stringify(t.project()), p0)
  // A playbook resolves in the rule's own level: a project-only playbook does not serve a global rule.
  await t.ctx.runCli(['playbooks', 'set', '--project', 'deploy', '# Deploy'])
  const miss = await t.ctx.runCli(['rules', 'add', '--global', J(newRule('d', { playbook: 'deploy' }))])
  assert.equal(miss.code, 1)
  assert.match(miss.stderr, /playbook deploy not found in .*\(the global folder, where this rule's playbook resolves\): write it first \(ccc autopilot playbooks set --global deploy -\)/)
  assert.match((await t.ctx.runCli(['rules', 'add', '--project', J(newRule('d', { playbook: 'deploy' }))])).stdout, /^Added to the project rules\./)
  // Reads show both levels: show has a header per level when both have the playbook.
  const both = (await t.ctx.runCli(['playbooks', 'show', 'check'])).stdout
  assert.equal(both, '--- project: playbooks/check.md ---\nProject check.\n\n--- global: playbooks/check.md ---\nGlobal check.\n')
  assert.equal((await t.ctx.runCli(['playbooks', 'show', '--global', 'check'])).stdout, 'Global check.\n')
  const pl = (await t.ctx.runCli(['playbooks'])).stdout
  assert.match(pl, /^Project playbooks in .*:\n {2}check .*\n {2}deploy .*used by d\n[\s\S]*Global playbooks in .*:\n {2}check .*used by mail, down\n/)
  // A dry run of JSON names its level too.
  const dry = await t.ctx.runCli(['test', J(newRule('try'))])
  assert.equal(dry.code, 2)
  assert.match((await t.ctx.runCli(['test', '--global', J(newRule('try'))])).stdout, /Rule global:try is the JSON you gave/)
  t.done()
})

test('one level only: writes need no flag; a flag for the missing level is refused', async () => {
  const t = await setup([rule('down')])
  assert.match((await t.ctx.runCli(['rules', 'disable', 'down'])).stdout, /^Switched off\. Rule project:down/)
  const g = await t.ctx.runCli(['rules', 'add', '--global', J(newRule('x'))])
  assert.ok(g.code, 'refused')
  assert.match(g.stderr, /There is no global rules folder: the app setting "Global rules folder" is empty/)
  t.done()
})

test('a v1 rules.json beside no autopilot-rules.json is never read: one plain note, no problem', async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'autopilot-test-'))
  fs.writeFileSync(path.join(dir, 'rules.json'), J([{ id: 'old', match: { source: 'bronos.jira' }, on: true }]))
  const ctx = fakeCtx({ globalFolder: dir })
  const clock = fakeClock()
  const ap = createAutopilot(ctx, { now: clock.now, timers: clock.timers, home: '/home/ann' })
  await ap.first
  const st = (await ctx.runCli([])).stdout
  assert.match(st, /\nNote: Global folder: an old v1 rules.json is in this folder and is not read \(v2 reads autopilot-rules.json\); Claude can port it with the autopilot-rules skill on request\n/)
  assert.doesNotMatch(st, /Problems|!/)
  assert.match((await ctx.runCli(['rules'])).stdout, /\n {2}Note: an old v1 rules.json/)
  assert.equal(ctx.lastState().problems.length, 0)
  assert.equal(ctx.lastState().hints.length, 1)
  assert.equal(fs.readFileSync(path.join(dir, 'rules.json'), 'utf8'), J([{ id: 'old', match: { source: 'bronos.jira' }, on: true }]), 'never written')
  ap.dispose()
  removeFolder(dir)
})

test('help names every command the parser knows', () => {
  for (const sub of CLI.RULES_SUBS) if (sub !== 'list') assert.ok(CLI.HELP.includes(`ccc autopilot rules ${sub}`), sub)
  for (const sub of CLI.PLAYBOOKS_SUBS) if (sub !== 'list') assert.ok(CLI.HELP.includes(`ccc autopilot playbooks ${sub}`), sub)
  assert.ok(CLI.HELP.includes('ccc autopilot test [rule|<json>|-]'))
})

test('rules add and playbooks set work into a missing file and a missing folder', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-cli-new-'))
  try {
    const folder = path.join(base, 'a', 'rules')
    const ctx = fakeCtx({ folder })
    const clock = fakeClock()
    const ap = createAutopilot(ctx, { now: clock.now, timers: clock.timers, home: '/home/ann' })
    await ap.first
    const pb = await ctx.runCli(['playbooks', 'set', '--project', 'check', '-'], undefined, 'Check it.\n')
    assert.equal(pb.code, undefined, pb.stderr)
    assert.ok(fs.statSync(path.join(folder, 'playbooks', 'check.md')).isFile())
    fs.rmSync(path.join(folder, 'autopilot-rules.json'), { force: true })
    const r = await ctx.runCli(['rules', 'add', '--project', J(newRule('a'))])
    assert.equal(r.code, undefined, r.stderr)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'autopilot-rules.json'), 'utf8')).map((x) => x.id), ['a'])
    ap.dispose()
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})
