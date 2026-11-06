'use strict'
// Rule and playbook management through the host, the way the panel drives it: a message with a
// request number and the hash it was shown, then the host's `result`. Every write path, invalid
// entries kept, the changed-on-disk refusal, atomic writes, names, links and size caps, the
// missing-folder actions and "Ask Claude". Temp folders only.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createAutopilot } = require('../dist/host')
const S = require('../dist/lib/schema')
const { fakeCtx, fakeClock, tempFolder, removeFolder, rule } = require('./fakes')

const PLAYBOOKS = { check: '# Check\nLook at it.\n' }

async function setup(o = {}) {
  const dir = o.dir || tempFolder(o.rules === undefined ? [rule('a'), rule('b', { enabled: false })] : o.rules, o.playbooks || PLAYBOOKS)
  const ctx = fakeCtx({ folder: o.folder || dir })
  const clock = fakeClock()
  const ap = createAutopilot(ctx, { now: clock.now, timers: clock.timers, home: '/home/ann', ...(o.opts || {}) })
  await ap.first
  let seq = 0
  const t = {
    ctx,
    ap,
    dir,
    /** Send a panel message (for the project level unless it names one) and answer the host's result for it. */
    async send(type, extra = {}) {
      const req = ++seq
      await ctx.sendPanel({ type, req, level: 'project', ...extra })
      return ctx.posts.filter((m) => m.type === 'result' && m.req === req).at(-1)
    },
    /** The state with the project level's fields on top (the folder these tests edit), `levels` kept. */
    st: () => ({ ...ctx.lastState(), ...ctx.lastState().levels.find((l) => l.level === 'project') }),
    file: (name = 'autopilot-rules.json') => fs.readFileSync(path.join(dir, name), 'utf8'),
    raw: () => JSON.parse(fs.readFileSync(path.join(dir, 'autopilot-rules.json'), 'utf8')),
    done() {
      ap.dispose()
      if (!o.dir) removeFolder(dir)
    },
  }
  return t
}

const pretty = (v) => `${JSON.stringify(v, null, 2)}\n`
const tmpFiles = (dir) => fs.readdirSync(dir, { recursive: true }).filter((n) => String(n).endsWith('.tmp'))

/** A full rule as the form sends it. */
function formRule(id, o = {}) {
  return {
    id,
    name: 'made in the panel',
    enabled: false,
    sources: ['bronos.jira'],
    when: [{ field: 'place.name', op: 'is', value: 'Support' }, { field: 'title', op: 'contains', value: 'Login broken' }],
    jev: { question: 'Is a script missing on a site?', min: 0.8 },
    playbook: 'check',
    check: 'The ticket reports that a script is missing on a site.',
    model: 'sonnet',
    effort: 'low',
    onChange: false,
    limits: { perDay: 5, cooldownMinutes: 60 },
    ...o,
  }
}

test('toggle: writes enabled in place (or after the id), pretty-printed with a trailing newline', async () => {
  const t = await setup()
  const before = t.raw()
  let r = await t.send('toggleRule', { index: 1, id: 'b', on: true, hash: t.st().rulesHash })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.op, 'toggleRule')
  assert.deepEqual(t.raw()[1], { ...before[1], enabled: true })
  assert.deepEqual(Object.keys(t.raw()[1]), Object.keys(before[1]), 'enabled stays where it was')
  assert.equal(t.file(), pretty(t.raw()))
  assert.equal(t.st().entries[1].on, true, 'the state is published after the write')
  r = await t.send('toggleRule', { index: 0, id: 'a', on: false, hash: t.st().rulesHash })
  assert.equal(r.ok, true)
  assert.deepEqual(Object.keys(t.raw()[0]), ['id', 'enabled', 'sources', 'when', 'check', 'playbook'])
  assert.equal(t.raw()[0].enabled, false)
  // A wrong id at the index is the panel looking at another file: stale.
  r = await t.send('toggleRule', { index: 0, id: 'b', on: true, hash: t.st().rulesHash })
  assert.deepEqual([r.ok, r.stale], [false, true])
  r = await t.send('toggleRule', { index: 0, id: 'a', on: 'yes', hash: t.st().rulesHash })
  assert.equal(r.ok, false)
  t.done()
})

test('create: a valid rule is added in key order; an invalid one is refused per field and writes nothing', async () => {
  const t = await setup()
  let r = await t.send('saveRule', { index: null, hash: t.st().rulesHash, rule: formRule('new-one') })
  assert.equal(r.ok, true, r.error)
  const got = t.raw()[2]
  assert.deepEqual(Object.keys(got), ['id', 'name', 'enabled', 'sources', 'when', 'jev', 'playbook', 'check', 'model', 'effort', 'onChange', 'limits'])
  assert.deepEqual(got.when[1], { field: 'title', op: 'contains', value: 'Login broken' }, 'written as typed, not lower-cased')
  const entry = t.st().entries[2]
  assert.equal(entry.ok, true)
  assert.match(entry.summary, /^bronos.jira, place.name is Support and title contains Login broken, Jev ≥ 0.8 · playbook check \(sonnet low\)/)
  const before = t.file()
  r = await t.send('saveRule', { index: null, hash: t.st().rulesHash, rule: formRule('bad id', { sources: [], limits: { perDay: 0 } }) })
  assert.equal(r.ok, false)
  assert.match(r.fieldErrors.id, /^id must be/)
  assert.match(r.fieldErrors.sources, /^sources is an empty list: choose the sources/)
  assert.match(r.fieldErrors['limits.perDay'], /from 1 to 100/)
  assert.equal(t.file(), before)
  r = await t.send('saveRule', { index: null, hash: t.st().rulesHash, rule: formRule('a') })
  assert.match(r.fieldErrors.id, /used by another rule/)
  assert.equal(t.file(), before)
  t.done()
})

test('create with "New playbook…": the rule and a first playbook text; an existing playbook is kept', async () => {
  const t = await setup()
  const r = await t.send('saveRule', { index: null, hash: t.st().rulesHash, rule: formRule('fresh', { playbook: 'fresh-check' }), newPlaybook: true })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.playbook, 'fresh-check')
  assert.match(t.file('playbooks/fresh-check.md'), /^# fresh-check\n/)
  assert.equal(t.st().entries[2].ok, true, 'the rule loads with its new playbook')
  const r2 = await t.send('saveRule', { index: null, hash: t.st().rulesHash, rule: formRule('again', { playbook: 'check' }), newPlaybook: true })
  assert.equal(r2.ok, true)
  assert.equal(t.file('playbooks/check.md'), PLAYBOOKS.check)
  t.done()
})

test('edit: replaces only that entry; unknown keys of the entry are kept; every other entry is untouched', async () => {
  const odd = { id: 'odd', note: 'kept', sources: ['*'], jev: { question: 'q?', mni: 1 }, hours: { from: '22:00', to: '07:00', days: 'weekdays' }, check: 'c', playbook: 'check', txt: ['typo'], limits: { perDay: 2, perHour: 1 } }
  const t = await setup({ rules: [rule('a'), odd, rule('c', { enabled: false })] })
  const before = t.raw()
  const r = await t.send('saveRule', { index: 1, id: 'odd', hash: t.st().rulesHash, rule: formRule('renamed', { when: [{ field: 'title', op: 'contains', value: 'y' }], hours: { from: '23:00', to: '06:00' } }) })
  assert.equal(r.ok, true, r.error)
  const after = t.raw()
  assert.deepEqual(after[0], before[0])
  assert.deepEqual(after[2], before[2])
  assert.equal(after[1].id, 'renamed')
  assert.deepEqual(after[1].when, [{ field: 'title', op: 'contains', value: 'y' }])
  assert.deepEqual(after[1].jev, { question: 'Is a script missing on a site?', min: 0.8, mni: 1 }, 'a key of jev the form cannot show is kept')
  assert.deepEqual(after[1].hours, { from: '23:00', to: '06:00', days: 'weekdays' })
  assert.equal(after[1].note, 'kept')
  assert.deepEqual(after[1].txt, ['typo'])
  assert.deepEqual(after[1].limits, { perDay: 5, cooldownMinutes: 60, perHour: 1 })
  assert.ok(t.st().entries[1].warnings.some((w) => w.includes('"txt"')), 'the warning about it stays')
  t.done()
})

test('delete: removes one entry, valid or not', async () => {
  const t = await setup({ rules: [rule('a'), 42, rule('c')] })
  let r = await t.send('deleteRule', { index: 1, id: null, hash: t.st().rulesHash })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(t.raw().map((e) => e.id), ['a', 'c'])
  r = await t.send('deleteRule', { index: 0, id: 'a', hash: t.st().rulesHash })
  assert.equal(r.ok, true)
  assert.deepEqual(t.raw().map((e) => e.id), ['c'])
  r = await t.send('deleteRule', { index: 5, id: 'c', hash: t.st().rulesHash })
  assert.deepEqual([r.ok, r.stale], [false, true])
  t.done()
})

test('a save writes back every entry it did not edit exactly as it was, invalid ones included', async () => {
  const src = '[42, {"id":"bad id","x":[1,2]}, {"id":"a","sources":["*"],"when":[{"field":"title","op":"contains","value":"down"}],"check":"c","playbook":"check"},\n {"id": "x", "sources": "nope", "__proto__": {"p": 1}}, "text", null]'
  const dir = tempFolder(src, PLAYBOOKS)
  const t = await setup({ dir })
  const entries = t.st().entries
  assert.deepEqual(entries.map((e) => [e.id, e.ok]), [[null, false], ['bad id', false], ['a', true], ['x', false], [null, false], [null, false]])
  assert.match(entries[1].problem, /^id must be/)
  assert.match(entries[3].problem, /^sources must be a list/)
  const r = await t.send('toggleRule', { index: 2, id: 'a', on: false, hash: t.st().rulesHash })
  assert.equal(r.ok, true, r.error)
  const want = JSON.parse(src)
  want[2] = { id: 'a', enabled: false, sources: ['*'], when: [{ field: 'title', op: 'contains', value: 'down' }], check: 'c', playbook: 'check' }
  assert.deepEqual(t.raw(), want)
  assert.equal(Object.hasOwn(t.raw()[3], '__proto__'), true, 'an odd key is written back, not lost')
  t.done()
  removeFolder(dir)
})

test('changed on disk: a write over a hand edit is refused, the fresh state resent, the edit kept', async () => {
  const t = await setup()
  const shown = t.st().rulesHash
  const hand = pretty([rule('a'), rule('b', { enabled: false }), rule('hand')])
  fs.writeFileSync(path.join(t.dir, 'autopilot-rules.json'), hand)
  const posts = t.ctx.posts.length
  let r = await t.send('toggleRule', { index: 1, id: 'b', on: true, hash: shown })
  assert.deepEqual([r.ok, r.stale, r.error], [false, true, 'changed on disk: reloaded'])
  assert.equal(t.file(), hand, 'the hand edit is never overwritten')
  const fresh = t.ctx.posts.slice(posts).find((m) => m.type === 'state')
  assert.ok(fresh, 'the fresh state goes out before the result')
  const fl = fresh.levels.find((l) => l.level === 'project')
  assert.notEqual(fl.rulesHash, shown)
  assert.deepEqual(fl.entries.map((e) => e.id), ['a', 'b', 'hand'])
  // The host read the file again on its own (a refresh) before the panel wrote: still refused.
  fs.writeFileSync(path.join(t.dir, 'autopilot-rules.json'), pretty([rule('a'), rule('b', { enabled: false })]))
  const seen = t.st().rulesHash
  await t.ap.tick()
  r = await t.send('deleteRule', { index: 0, id: 'a', hash: seen })
  assert.equal(r.stale, true)
  // With the hash the panel now has, the same write goes through.
  r = await t.send('toggleRule', { index: 1, id: 'b', on: true, hash: t.st().rulesHash })
  assert.equal(r.ok, true, r.error)
  t.done()
})

test('atomic writes: no temp file is left, and a failed rename leaves the file as it was', async () => {
  const t = await setup()
  await t.send('toggleRule', { index: 0, id: 'a', on: false, hash: t.st().rulesHash })
  await t.send('savePlaybook', { name: 'more', body: 'More checks.', create: true })
  assert.deepEqual(tmpFiles(t.dir), [])
  t.done()

  let renames = 0
  const broken = { ...fsp, rename: async () => { renames++; throw new Error('disk full') } }
  const b = await setup({ opts: { fs: broken } })
  const before = b.file()
  const r = await b.send('toggleRule', { index: 0, id: 'a', on: false, hash: b.st().rulesHash })
  assert.equal(r.ok, false)
  assert.match(r.error, /disk full/)
  assert.equal(renames, 1)
  assert.equal(b.file(), before)
  assert.deepEqual(tmpFiles(b.dir), [], 'the temp file is removed')
  b.done()
})

test('names and paths: traversal, absolute paths and dots refused; links are never written through', async () => {
  const t = await setup()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-outside-'))
  try {
    for (const name of ['../x', '../../etc/passwd', '/etc/passwd', 'a.b', 'sub/x', '', '.hidden', 'x\\y', 7]) {
      const r = await t.send('savePlaybook', { name, body: 'x', create: true })
      assert.equal(r.ok, false, String(name))
      assert.match(r.error, /a playbook name is/, String(name))
      assert.equal((await t.send('openPlaybook', { name })).ok, false)
      assert.equal((await t.send('deletePlaybook', { name })).ok, false)
    }
    assert.deepEqual(fs.readdirSync(outside), [])
    // A playbook that is a link to a file outside: not opened, written or deleted.
    const target = path.join(outside, 'secret.md')
    fs.writeFileSync(target, 'outside\n')
    fs.symlinkSync(target, path.join(t.dir, 'playbooks', 'link.md'))
    await t.ap.tick()
    assert.deepEqual(t.st().playbookFiles.find((p) => p.name === 'link'), { name: 'link', size: 0, usedBy: [], link: true })
    let r = await t.send('openPlaybook', { name: 'link' })
    assert.match(r.error, /symbolic link/)
    r = await t.send('savePlaybook', { name: 'link', body: 'over', create: false, hash: null })
    assert.match(r.error, /symbolic link/)
    r = await t.send('deletePlaybook', { name: 'link' })
    assert.match(r.error, /symbolic link/)
    assert.equal(fs.readFileSync(target, 'utf8'), 'outside\n')
    assert.ok(fs.lstatSync(path.join(t.dir, 'playbooks', 'link.md')).isSymbolicLink())
    // autopilot-rules.json as a link: read (the loader follows it), never written.
    const real = path.join(outside, 'autopilot-rules.json')
    fs.renameSync(path.join(t.dir, 'autopilot-rules.json'), real)
    fs.symlinkSync(real, path.join(t.dir, 'autopilot-rules.json'))
    await t.ap.tick()
    const before = fs.readFileSync(real, 'utf8')
    r = await t.send('toggleRule', { index: 0, id: 'a', on: false, hash: t.st().rulesHash })
    assert.match(r.error, /autopilot-rules.json is a symbolic link/)
    assert.equal(fs.readFileSync(real, 'utf8'), before)
    assert.ok(fs.lstatSync(path.join(t.dir, 'autopilot-rules.json')).isSymbolicLink())
  } finally {
    t.done()
    removeFolder(outside)
  }
  // playbooks/ itself a link: refused.
  const u = await setup()
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-outside-'))
  fs.rmSync(path.join(u.dir, 'playbooks'), { recursive: true })
  fs.symlinkSync(elsewhere, path.join(u.dir, 'playbooks'))
  const r = await u.send('savePlaybook', { name: 'x', body: 'x', create: true })
  assert.match(r.error, /playbooks\/ is a symbolic link/)
  assert.deepEqual(fs.readdirSync(elsewhere), [])
  u.done()
  removeFolder(elsewhere)
})

test('size caps: a playbook over 64 KiB, a 201st rule, a rules file over 512 KiB', async () => {
  assert.deepEqual([S.MAX_PLAYBOOK_BYTES, S.MAX_RULES, S.MAX_RULES_BYTES], [64 * 1024, 200, 512 * 1024])
  const t = await setup()
  let r = await t.send('savePlaybook', { name: 'big', body: 'x'.repeat(S.MAX_PLAYBOOK_BYTES), create: true })
  assert.match(r.error, /at most 64 KiB/)
  assert.equal(fs.existsSync(path.join(t.dir, 'playbooks', 'big.md')), false)
  r = await t.send('savePlaybook', { name: 'fits', body: 'x'.repeat(S.MAX_PLAYBOOK_BYTES - 1), create: true })
  assert.equal(r.ok, true, r.error)
  t.done()
  // A file that fits (an unknown key of the first rule is kept as written) but not with one more rule.
  const huge = await setup({ rules: [rule('a', { note: 'n'.repeat(S.MAX_RULES_BYTES - 1000) })] })
  const before = huge.file()
  r = await huge.send('saveRule', { index: null, hash: huge.st().rulesHash, rule: formRule('one-more', { when: Array.from({ length: 20 }, (_, i) => ({ field: 'title', op: 'contains', value: `${i}`.padEnd(190, "x") })) }) })
  assert.match(r.error, /would be over 512 KiB/)
  assert.equal(huge.file(), before)
  huge.done()
  const full = await setup({ rules: Array.from({ length: S.MAX_RULES }, (_, i) => rule(`r${i}`)) })
  r = await full.send('saveRule', { index: null, hash: full.st().rulesHash, rule: formRule('one-more') })
  assert.match(r.error, /at most 200 rules/)
  full.done()
})

test('playbooks: create, open, edit, delete; delete refused while a rule (valid or not) uses it; a hand edit refused', async () => {
  const t = await setup({ rules: [rule('a'), { id: 'broken', playbook: 'shared' }, rule('c', { playbook: 'shared' })], playbooks: { check: 'Check.', shared: 'Shared.' } })
  let r = await t.send('savePlaybook', { name: 'new-one', body: '# New\r\nSteps.', create: true })
  assert.equal(r.ok, true, r.error)
  assert.equal(t.file('playbooks/new-one.md'), '# New\nSteps.\n')
  r = await t.send('savePlaybook', { name: 'new-one', body: 'again', create: true })
  assert.match(r.error, /exists/)
  r = await t.send('savePlaybook', { name: 'empty', body: '  \n', create: true })
  assert.match(r.error, /empty/)
  assert.deepEqual(t.st().playbookFiles.map((p) => [p.name, p.usedBy]), [['check', ['a']], ['new-one', []], ['shared', ['broken', 'c']]])
  const opened = await t.send('openPlaybook', { name: 'new-one' })
  assert.equal(opened.body, '# New\nSteps.\n')
  r = await t.send('savePlaybook', { name: 'new-one', body: 'Edited.', create: false, hash: opened.hash })
  assert.equal(r.ok, true, r.error)
  assert.equal(t.file('playbooks/new-one.md'), 'Edited.\n')
  // Edited by hand since the editor opened it: refused, with the hash now.
  fs.writeFileSync(path.join(t.dir, 'playbooks', 'new-one.md'), 'By hand.\n')
  r = await t.send('savePlaybook', { name: 'new-one', body: 'Mine.', create: false, hash: opened.hash })
  assert.deepEqual([r.ok, r.stale], [false, true])
  assert.equal(t.file('playbooks/new-one.md'), 'By hand.\n')
  r = await t.send('savePlaybook', { name: 'new-one', body: 'Mine.', create: false, hash: r.hash })
  assert.equal(r.ok, true, 'saved over it once the person chose to')
  r = await t.send('deletePlaybook', { name: 'shared' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'playbook shared is used by: broken, c. Change or delete those rules first.')
  assert.deepEqual(r.usedBy, ['broken', 'c'])
  assert.ok(fs.existsSync(path.join(t.dir, 'playbooks', 'shared.md')))
  r = await t.send('deletePlaybook', { name: 'new-one' })
  assert.equal(r.ok, true, r.error)
  assert.equal(fs.existsSync(path.join(t.dir, 'playbooks', 'new-one.md')), false)
  assert.deepEqual(t.st().playbookFiles.map((p) => p.name), ['check', 'shared'])
  t.done()
})

test('autopilot-rules.json that is not a list is never rewritten; a playbook delete waits for it to be fixed', async () => {
  const dir = tempFolder('{"rules": []}', PLAYBOOKS)
  const t = await setup({ dir })
  assert.equal(t.st().editable, false)
  let r = await t.send('saveRule', { index: null, hash: t.st().rulesHash, rule: formRule('x') })
  assert.match(r.error, /not a JSON list/)
  r = await t.send('deletePlaybook', { name: 'check' })
  assert.match(r.error, /cannot be told/)
  assert.equal(t.file(), '{"rules": []}')
  t.done()
  removeFolder(dir)
})

test('missing folder: create it (autopilot-rules.json [] and playbooks/), or add the examples with every rule off', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-new-'))
  try {
    const folder = path.join(base, 'rules')
    const t = await setup({ dir: base, folder })
    assert.equal(t.st().folderState, 'missing')
    let r = await t.send('createFolder')
    assert.equal(r.ok, true, r.error)
    assert.equal(fs.readFileSync(path.join(folder, 'autopilot-rules.json'), 'utf8'), '[]\n')
    assert.ok(fs.statSync(path.join(folder, 'playbooks')).isDirectory())
    assert.deepEqual([t.st().folderState, t.st().editable, t.st().entries], ['ok', true, []])
    r = await t.send('createFolder')
    assert.match(r.error, /already exists/)
    // Into the empty list: the examples, every rule off; a playbook of the same name is kept.
    fs.writeFileSync(path.join(folder, 'playbooks', 'site-check.md'), 'Mine.\n')
    r = await t.send('addExamples')
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(r.kept, ['site-check'])
    assert.equal(fs.readFileSync(path.join(folder, 'playbooks', 'site-check.md'), 'utf8'), 'Mine.\n')
    const examples = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'autopilot-rules.json'), 'utf8'))
    const got = JSON.parse(fs.readFileSync(path.join(folder, 'autopilot-rules.json'), 'utf8'))
    assert.equal(got.length, examples.length)
    assert.ok(got.every((x) => x.enabled === false))
    assert.ok(examples.every((x) => x.enabled === false), 'the shipped examples are all off')
    assert.deepEqual(got, examples)
    assert.deepEqual(t.st().problems, [])
    r = await t.send('addExamples')
    assert.match(r.error, /already has rules/)
    t.done()
    // Straight into a folder that does not exist yet.
    const other = path.join(base, 'other')
    const u = await setup({ dir: base, folder: other })
    r = await u.send('addExamples')
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(r.kept, [])
    assert.ok(fs.existsSync(path.join(other, 'playbooks', 'site-check.md')))
    assert.deepEqual(u.st().rules.map((x) => x.on), examples.map(() => false))
    u.done()
  } finally {
    removeFolder(base)
  }
})

test('Ask Claude: opens a tab in the project with the prompt naming the folder', async () => {
  const t = await setup()
  const r = await t.send('askClaude')
  assert.equal(r.ok, true, r.error)
  assert.equal(r.tabId, 'tab-1')
  const [o] = t.ctx.opened
  assert.equal(o.cwd, '/work/project')
  assert.doesNotMatch(o.prompt, /^[/!#&]/)
  assert.ok(o.prompt.includes(t.dir))
  assert.match(o.prompt, /`ccc autopilot format`/)
  assert.match(o.prompt, /`ccc autopilot reload` and `ccc autopilot test <id>`/)
  t.ctx.openError = 'at most 5 sessions.open a minute'
  const refused = await t.send('askClaude')
  assert.match(refused.error, /at most 5/)
  t.done()
})

test('two levels: a panel edit names its level and changes only that file, with that file\'s hash', async () => {
  const gdir = tempFolder([rule('g1')], { check: 'Global.\n' })
  const t = await setup()
  t.ap.dispose()
  // The same project folder, now with a global folder too (a fresh host: settings are read at start).
  const ctx = fakeCtx({ folder: t.dir, globalFolder: gdir })
  const clock = fakeClock()
  const ap = createAutopilot(ctx, { now: clock.now, timers: clock.timers, home: '/home/ann' })
  await ap.first
  let seq = 0
  const send = async (m) => {
    const req = ++seq
    await ctx.sendPanel({ req, ...m })
    return ctx.posts.filter((x) => x.type === 'result' && x.req === req).at(-1)
  }
  const lv = (l) => ctx.lastState().levels.find((x) => x.level === l)
  const projectBefore = t.file()
  const gfile = () => JSON.parse(fs.readFileSync(path.join(gdir, 'autopilot-rules.json'), 'utf8'))
  try {
    assert.deepEqual(ctx.lastState().rules.map((r) => r.ref), ['project:a', 'project:b', 'global:g1'], 'project rules first')
    // The project's hash on a global edit is a stale view of that file: refused, nothing written.
    let r = await send({ type: 'toggleRule', level: 'global', index: 0, id: 'g1', on: false, hash: lv('project').rulesHash })
    assert.equal(r.stale, true)
    assert.equal(gfile()[0].enabled, undefined)
    // No level, or one that is not a level: refused, nothing written.
    r = await send({ type: 'toggleRule', index: 0, id: 'g1', on: false, hash: lv('global').rulesHash })
    assert.match(r.error, /say which rules: project or global/)
    r = await send({ type: 'toggleRule', level: 'app', index: 0, id: 'g1', on: false, hash: lv('global').rulesHash })
    assert.equal(r.ok, false)
    r = await send({ type: 'saveRule', level: 'global', index: null, hash: lv('global').rulesHash, rule: formRule('a') })
    assert.equal(r.ok, true, 'an id the project level has is free at the global level')
    r = await send({ type: 'toggleRule', level: 'global', index: 0, id: 'g1', on: false, hash: lv('global').rulesHash })
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(gfile().map((e) => [e.id, e.enabled]), [['g1', false], ['a', false]])
    assert.equal(t.file(), projectBefore, 'the project file is never touched by a global edit')
    // A playbook is read and written in its level's folder.
    r = await send({ type: 'openPlaybook', level: 'global', name: 'check' })
    assert.equal(r.body, 'Global.\n')
    r = await send({ type: 'openPlaybook', level: 'project', name: 'check' })
    assert.equal(r.body, PLAYBOOKS.check)
    // Ask Claude names both folders and asks which level a rule belongs to.
    r = await send({ type: 'askClaude' })
    assert.equal(r.ok, true, r.error)
    const prompt = ctx.opened.at(-1).prompt
    assert.ok(prompt.includes(t.dir) && prompt.includes(gdir))
    assert.match(prompt, /ask me which level/)
  } finally {
    ap.dispose()
    removeFolder(t.dir)
    removeFolder(gdir)
  }
})

test('unknown and malformed messages do nothing', async () => {
  const t = await setup()
  const before = t.file()
  await t.ctx.sendPanel({ type: 'writeFile', path: '/etc/passwd' })
  await t.ctx.sendPanel({ type: 'toString' })
  await t.ctx.sendPanel({ type: 'saveRule', req: 1, rule: 'x', hash: t.st().rulesHash })
  assert.equal(t.file(), before)
  assert.equal(t.ctx.posts.filter((m) => m.type === 'result').at(-1).ok, false)
  t.done()
})

test('the v2 form round-trips a rule through the host: unknown keys of the entry and of jev, hours and limits are kept', async () => {
  const V = require('../panels/viewlogic')
  const odd = { id: 'odd', note: 'kept', sources: ['bronos.jira', 'bronos.gone'], when: [{ field: 'from.name', op: 'in', value: ['a', 'b'] }], jev: { question: 'q?', min: 0.9, mni: 1 }, hours: { from: '22:00', to: '07:00', days: 'weekdays' }, playbook: 'check', model: 'opus', txt: ['typo'], limits: { perDay: 2, cooldownMinutes: 3, perHour: 1 } }
  const t = await setup({ rules: [rule('a'), odd] })
  const st = t.st()
  const e = st.entries[1]
  // Open the form on the entry, change one field, save the rule the form stands for.
  const f = { ...V.formFromRaw(e.raw, st, 'project'), name: 'Renamed' }
  assert.deepEqual(V.formErrors(f, st, 1), {})
  const r = await t.send('saveRule', { index: 1, id: 'odd', hash: st.rulesHash, rule: V.formToRule(f) })
  assert.equal(r.ok, true, r.error)
  const after = t.raw()[1]
  assert.equal(after.name, 'Renamed')
  assert.deepEqual(after.sources, ['bronos.jira', 'bronos.gone'], 'a source no feed has is kept')
  assert.deepEqual(after.when, odd.when)
  assert.deepEqual(after.jev, odd.jev)
  assert.deepEqual(after.hours, odd.hours)
  assert.deepEqual(after.limits, odd.limits)
  assert.equal(after.note, 'kept')
  assert.deepEqual(after.txt, ['typo'])
  assert.equal(after.model, 'opus')
  // A new sources-only rule (confirmed in the form) is accepted by the host.
  const g = { ...V.formFromRaw(null, t.st(), 'project'), id: 'every', sourceAny: true, confirmAll: true }
  assert.deepEqual(V.formErrors(g, t.st(), null), {})
  const r2 = await t.send('saveRule', { index: null, id: null, hash: t.st().rulesHash, rule: V.formToRule(g) })
  assert.equal(r2.ok, true, r2.error)
  assert.deepEqual(t.raw().at(-1), { id: 'every', enabled: false, sources: ['*'], playbook: 'check', onChange: false, limits: { perDay: 10, cooldownMinutes: 30 } })
  t.done()
})

test('New rule works before a rules file exists: a missing file or folder is editable, the first save makes both', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-first-'))
  try {
    // Folder there, no file: editable with a null hash.
    const noFile = path.join(base, 'nofile')
    fs.mkdirSync(path.join(noFile, 'playbooks'), { recursive: true })
    fs.writeFileSync(path.join(noFile, 'playbooks', 'check.md'), 'Check.\n')
    let t = await setup({ dir: base, folder: noFile })
    assert.deepEqual([t.st().folderState, t.st().editable, t.st().rulesHash], ['noRules', true, null])
    let r = await t.send('saveRule', { index: null, hash: null, rule: formRule('x') })
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(noFile, 'autopilot-rules.json'), 'utf8')).map((e) => e.id), ['x'])
    t.done()
    // Folder missing: editable; the first save creates the folder and the file.
    const none = path.join(base, 'deep', 'er')
    t = await setup({ dir: base, folder: none })
    assert.deepEqual([t.st().folderState, t.st().editable], ['missing', true])
    r = await t.send('saveRule', { index: null, hash: null, rule: formRule('y') })
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(none, 'autopilot-rules.json'), 'utf8')).map((e) => e.id), ['y'])
    t.done()
    // A playbook save into a missing folder makes playbooks/.
    const pbOnly = path.join(base, 'pb')
    t = await setup({ dir: base, folder: pbOnly })
    r = await t.send('savePlaybook', { name: 'p1', body: 'Hi', create: true })
    assert.equal(r.ok, true, r.error)
    assert.ok(fs.statSync(path.join(pbOnly, 'playbooks', 'p1.md')).isFile())
    t.done()
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('a rules file that appears between the load and the first save is a conflict, never overwritten', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-race-'))
  try {
    const folder = path.join(base, 'rules')
    fs.mkdirSync(folder)
    const t = await setup({ dir: base, folder })
    assert.equal(t.st().rulesHash, null)
    const theirs = pretty([rule('theirs')])
    fs.writeFileSync(path.join(folder, 'autopilot-rules.json'), theirs)
    const r = await t.send('saveRule', { index: null, hash: null, rule: formRule('x') })
    assert.equal(r.ok, false)
    assert.equal(r.stale, true)
    assert.equal(fs.readFileSync(path.join(folder, 'autopilot-rules.json'), 'utf8'), theirs)
    t.done()
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('Ask Claude opens a selected tab: the person clicked, so the tab they asked for comes to the front', async () => {
  const t = await setup()
  const r = await t.send('askClaude')
  assert.equal(r.ok, true, r.error)
  assert.equal(t.ctx.opened.length, 1)
  // Only the tabs a rule opens on its own stay in the background (design-v2 "One tab per item").
  assert.equal(t.ctx.opened[0].focus, true)
  t.done()
  removeFolder(t.dir)
})

// ---- 0.3.0: base.md and the act-mode playbook stub ----

test('base.md: open (absent, then with its hash), save over what was shown only, an empty text removes it, the cap', async () => {
  const t = await setup()
  let o = await t.send('openBase')
  assert.deepEqual([o.ok, o.exists, o.body, o.hash, o.level], [true, false, '', null, 'project'])
  let r = await t.send('saveBase', { body: 'Answer in English.\r\n\r\n', hash: null })
  assert.equal(r.ok, true, r.error)
  assert.equal(t.file('base.md'), 'Answer in English.\n')
  assert.equal(t.st().base.size, 19, 'the state says it is in use, with its size')
  o = await t.send('openBase')
  assert.deepEqual([o.exists, o.body, o.hash], [true, 'Answer in English.\n', r.hash])
  // A hand edit since the editor read it: refused, kept.
  fs.writeFileSync(path.join(t.dir, 'base.md'), 'by hand\n')
  r = await t.send('saveBase', { body: 'mine', hash: o.hash })
  assert.deepEqual([r.ok, r.stale], [false, true])
  assert.equal(t.file('base.md'), 'by hand\n')
  // Absent was what the editor saw, but it is there now: refused too.
  r = await t.send('saveBase', { body: 'mine', hash: null })
  assert.equal(r.stale, true)
  o = await t.send('openBase')
  r = await t.send('saveBase', { body: 'x'.repeat(S.MAX_BASE_BYTES + 1), hash: o.hash })
  assert.equal(r.ok, false)
  assert.match(r.error, /base\.md is at most 16 KiB/)
  assert.equal(t.file('base.md'), 'by hand\n')
  r = await t.send('saveBase', { body: '  \n', hash: o.hash })
  assert.deepEqual([r.ok, r.removed, r.hash], [true, true, null])
  assert.equal(fs.existsSync(path.join(t.dir, 'base.md')), false)
  assert.equal(t.st().base, null)
  assert.equal(tmpFiles(t.dir).length, 0)
  t.done()
})

test('base.md: a link is never read or written through; an oversized hand-made file is a problem the state names', async () => {
  const t = await setup()
  const outside = path.join(os.tmpdir(), `ap-base-target-${process.pid}.md`)
  fs.writeFileSync(outside, 'secret\n')
  fs.symlinkSync(outside, path.join(t.dir, 'base.md'))
  assert.equal((await t.send('openBase')).ok, false)
  assert.equal((await t.send('saveBase', { body: 'x', hash: null })).ok, false)
  assert.equal(fs.readFileSync(outside, 'utf8'), 'secret\n')
  fs.unlinkSync(path.join(t.dir, 'base.md'))
  fs.unlinkSync(outside)
  fs.writeFileSync(path.join(t.dir, 'base.md'), 'y'.repeat(S.MAX_BASE_BYTES + 10))
  await t.ap.tick()
  assert.match(t.st().baseProblem, /base\.md: over 16 KiB/)
  t.done()
})

test('a new act-mode rule with "New playbook…": the stub has an empty Allowed actions heading, so the rule is a problem until it is listed', async () => {
  const t = await setup()
  const r = await t.send('saveRule', { index: null, hash: t.st().rulesHash, rule: formRule('acting', { playbook: 'acting', mode: 'act' }), newPlaybook: true })
  assert.equal(r.ok, true, r.error)
  const stub = t.file('playbooks/acting.md')
  assert.match(stub, /\n## Allowed actions\n\n<!-- /)
  assert.equal(S.hasAllowedActions(stub), false)
  const e = t.st().entries.find((x) => x.id === 'acting')
  assert.match(e.problem, /mode "act" needs an "Allowed actions" section in playbooks\/acting\.md/)
  // Listed: the rule loads.
  fs.writeFileSync(path.join(t.dir, 'playbooks', 'acting.md'), `${stub}- Re-run the check once.\n`)
  await t.ap.tick()
  assert.equal(t.st().entries.find((x) => x.id === 'acting').problem, null)
  // An investigate stub has no such heading.
  await t.send('saveRule', { index: null, hash: t.st().rulesHash, rule: formRule('looking', { playbook: 'looking' }), newPlaybook: true })
  assert.doesNotMatch(t.file('playbooks/looking.md'), /Allowed actions/)
  t.done()
})

test('an act rule from the panel: stored with act and no session keys; a missing action, open, or both kinds refused per field', async () => {
  const t = await setup()
  const act = { id: 'mark', enabled: false, sources: ['bronos.gmail'], when: [{ field: 'title', op: 'contains', value: 'Done' }], act: 'markRead', limits: { perDay: 100, cooldownMinutes: 0 } }
  let r = await t.send('saveRule', { index: null, hash: t.st().rulesHash, rule: act })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(Object.keys(t.raw()[2]), ['id', 'enabled', 'sources', 'when', 'act', 'limits'])
  r = await t.send('saveRule', { index: null, hash: t.st().rulesHash, rule: { ...act, id: 'o', act: 'open' } })
  assert.equal(r.ok, false)
  assert.ok(r.fieldErrors.act)
  r = await t.send('saveRule', { index: null, hash: t.st().rulesHash, rule: { ...act, id: 'both', playbook: 'check' } })
  assert.ok(r.fieldErrors.playbook)
  r = await t.send('saveRule', { index: null, hash: t.st().rulesHash, rule: { ...act, id: 'm', model: 'sonnet' } })
  assert.ok(r.fieldErrors.model)
  assert.equal(t.raw().length, 3)
  t.done()
})
