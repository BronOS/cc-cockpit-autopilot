'use strict'
// Autopilot 0.4.0: the live Jira lookup behind the jira.* conditions, isNot / notIn, and onChange on act
// rules. Through the host over fakes (a fake gmail feed, a fake `jira` service), a fake clock for the
// 10-minute retry. Every name, key and address is example data (ABC-123, OPS-5, example.atlassian.net).
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAutopilot } = require('../dist/host')
const J = require('../dist/lib/jira')
const C = require('../dist/lib/conditions')
const S = require('../dist/lib/schema')
const { fakeCtx, fakeFeed, fakeJira, fakeClock, fakeStorage, item, settle, tempFolder, removeFolder, rule, NOW, MAIL } = require('./fakes')

const SRC = 'bronos.gmail'
const SENDER = 'jira@example.atlassian.net'
const PLAYBOOKS = { check: '# Check\nLook.' }
const ACTS = [{ id: 'open', label: 'Open' }, { id: 'markRead', label: 'Mark read' }]
/** A Jira notification mail about ABC-123 (the key in parentheses, as Jira writes it). */
const mail = (id, o = {}) => item(id, { title: '[JIRA] (ABC-123) Fix the login redirect', ...o, extra: { actions: ACTS, from: { name: 'Jira', address: SENDER }, ...(o.extra || {}) } })
const JIRA_WHEN = [
  { field: 'from.address', op: 'is', value: SENDER },
  { field: 'title', op: 'startsWith', value: '[JIRA]' },
  { field: 'jira.status', op: 'notIn', value: ['In Progress', 'Backlog'] },
]
/** An act rule on the mail source: markRead when the issue is not in progress or backlog. */
const actRule = (id, o = {}) => ({ id, sources: [SRC], when: JIRA_WHEN, act: 'markRead', limits: { perDay: 100, cooldownMinutes: 0 }, ...o })

async function setup(o = {}) {
  const dir = tempFolder(o.rules || [actRule('read')], PLAYBOOKS)
  const storage = fakeStorage()
  await storage.set('enabled', true)
  const ctx = fakeCtx({ folder: dir, storage, jira: o.jira === undefined ? fakeJira({ 'ABC-123': { status: 'Done', category: 'done', done: true } }) : o.jira })
  const clock = fakeClock()
  const feed = fakeFeed(MAIL, o.items || [])
  ctx.addProvider(SRC, feed)
  const ap = createAutopilot(ctx, { now: clock.now, timers: clock.timers, debounceMs: 1000, home: '/home/ann' })
  await ap.first
  const t = { ctx, clock, feed, ap, dir, jira: ctx.jira }
  t.push = async (items) => {
    feed.items = items
    ctx.emitFeed(SRC, 'sync', { items, state: 'ok', asOf: NOW })
    await settle()
    await clock.advance(1000)
    await t.quiet()
  }
  /** The judging queue empty and every lookup answered (an answer queues the item's decision again). */
  t.quiet = async () => {
    for (let i = 0; i < 4; i++) {
      await settle()
      await ap.idle()
    }
    await settle()
  }
  t.acts = () => feed.calls.filter((c) => c[0] === 'act')
  t.log = () => ap.state.recent()
  t.done = () => {
    ap.dispose()
    removeFolder(dir)
  }
  return t
}

// ---- the key ----

test('key: a parenthesised key wins, else the first key-shaped word, else none; UTF-8 is not preferred', () => {
  assert.equal(J.keyOfTitle('[JIRA] (ABC-123) Summary'), 'ABC-123')
  assert.equal(J.keyOfTitle('[JIRA] Ann Example assigned OPS-5 to you'), 'OPS-5')
  // The summary holds a key-shaped UTF-8 before... and after: the bracketed key is the issue.
  assert.equal(J.keyOfTitle('[JIRA] (ABC-123) Support UTF-8 in exports'), 'ABC-123')
  assert.equal(J.keyOfTitle('Support UTF-8 in exports (ABC-123)'), 'ABC-123')
  // Without a bracketed key the loose rule takes the first word, which is all that can be said.
  assert.equal(J.keyOfTitle('[JIRA] Ann assigned OPS-5 to you, see UTF-8'), 'OPS-5')
  for (const none of ['Weekly digest', '[JIRA] no key here', 'abc-123 lower case', 'A-1 one letter', 'ABC-0 zero', 'ABC-', 'XABC-123x', '', undefined, null, 7]) assert.equal(J.keyOfTitle(none), null, String(none))
  // Bounded: the service accepts at most 64 characters, the pattern stays inside that.
  assert.equal(J.keyOfTitle(`(${'A'.repeat(60)}-1)`), null)
  assert.equal(J.keyOfTitle(`(${'A'.repeat(50)}-1234567890)`), `${'A'.repeat(50)}-1234567890`)
  assert.ok(`${'A'.repeat(50)}-1234567890`.length <= 64)
})

test('maxAgeMs: the item\'s age between 15 s and the service default', () => {
  assert.equal(J.maxAgeFor({ time: NOW - 20000 }, NOW), 20000)
  assert.equal(J.maxAgeFor({ time: NOW - 1000 }, NOW), 15000)
  assert.equal(J.maxAgeFor({ time: NOW + 5000 }, NOW), 15000, 'a clock ahead of ours')
  assert.equal(J.maxAgeFor({ time: NOW - 3 * 3600000 }, NOW), 300000)
  assert.equal(J.maxAgeFor({}, NOW), 300000)
})

// ---- the conditions and their validation ----

test('isNot and notIn on text fields; the jira fields\' ops and values are checked like any field', () => {
  const m = { ...item('t1', { title: 'x' }), source: 'bronos.gmail', from: { name: 'Jira', address: SENDER }, place: { kind: 'folder', name: 'Inbox', status: 'Open' } }
  const holds = (field, op, value, it = m) => C.holds(C.conditionOf({ field, op, value }), it, 'mail', NOW)
  assert.equal(holds('place.status', 'isNot', 'open'), false)
  assert.equal(holds('place.status', 'isNot', 'Done'), true)
  assert.equal(holds('place.status', 'notIn', ['open', 'Done']), false)
  assert.equal(holds('place.status', 'notIn', ['Done', 'Closed']), true)
  assert.equal(holds('from.address', 'notIn', ['someone@example.com']), true)
  assert.equal(holds('place.status', 'notIn', ['x'], { ...m, place: undefined }), true, 'an absent field holds for the negative ops')
  assert.equal(holds('source', 'notIn', ['bronos.chat']), true)
  // jira.*: the fields read the issue riding on the item.
  const j = { ...m, jira: { status: 'Done', category: 'done', done: true, mine: false, assignee: 'Ann Example', priority: 'High', type: 'Bug' } }
  assert.equal(holds('jira.status', 'is', 'done', j), true)
  assert.equal(holds('jira.status', 'notIn', ['In Progress', 'Backlog'], j), true)
  assert.equal(holds('jira.status', 'in', ['In Progress', 'Backlog'], j), false)
  assert.equal(holds('jira.status', 'contains', 'on', j), true)
  assert.equal(holds('jira.category', 'is', 'done', j), true)
  assert.equal(holds('jira.category', 'notIn', ['new', 'indeterminate'], j), true)
  assert.equal(holds('jira.done', 'is', true, j), true)
  assert.equal(holds('jira.mine', 'is', true, j), false)
  assert.equal(holds('jira.assignee', 'is', 'ann example', j), true)
  assert.equal(holds('jira.priority', 'isNot', 'High', j), false)
  assert.equal(holds('jira.type', 'in', ['Bug', 'Task'], j), true)
  assert.equal(holds('jira.assignee', 'isNot', 'Ann Example', { ...j, jira: { ...j.jira, assignee: undefined } }), true, 'unassigned')
  // Bad ops and values are dropped like any field's.
  for (const bad of [
    { field: 'jira.done', op: 'contains', value: true },
    { field: 'jira.done', op: 'is', value: 'true' },
    { field: 'jira.mine', op: 'in', value: [true] },
    { field: 'jira.status', op: 'startsWith', value: 'In' },
    { field: 'jira.status', op: 'is', value: 5 },
    { field: 'jira.status', op: 'notIn', value: 'Done' },
    { field: 'jira.status', op: 'notIn', value: [] },
    { field: 'jira.category', op: 'is', value: 'Done' },
    { field: 'jira.category', op: 'contains', value: 'done' },
    { field: 'jira.key', op: 'is', value: 'ABC-123' },
    { field: 'jira.summary', op: 'contains', value: 'x' },
  ]) {
    assert.equal(C.conditionOf(bad), null, JSON.stringify(bad))
    const r = S.checkRule({ id: 'x', sources: ['*'], when: [bad], act: 'markRead' })
    assert.match(r.errors[0].message, /^when\[1\] is not a valid condition/, JSON.stringify(bad))
  }
  assert.deepEqual(S.checkRule({ id: 'x', sources: [SRC], when: JIRA_WHEN, act: 'markRead', onChange: true }).errors, [])
})

// ---- the ladder ----

test('the lookup runs only after the other conditions held, with maxAgeMs from the item\'s time', async () => {
  const t = await setup()
  await t.push([
    mail('other', { title: 'Weekly digest (ABC-123)', extra: { from: { name: 'News', address: 'news@example.com' } } }),
    mail('notjira', { title: 'Your invoice (ABC-123)' }),
  ])
  assert.deepEqual(t.jira.calls, [], 'a mail from elsewhere, and one without the prefix: no call at all')
  assert.deepEqual(t.acts(), [])
  // Freshness: a mail 40 s old (a little more by the time it is judged) asks for an answer at most that old; a fresher one the 15 s floor.
  await t.push([mail('m1', { time: NOW - 40000 }), mail('m2', { title: '[JIRA] (ABC-123) Another', time: NOW - 2000 }), ...t.feed.items])
  const ages = t.jira.calls.map((c) => c.opts.maxAgeMs).sort((a, b) => a - b)
  assert.equal(ages[0], 15000, 'the floor')
  assert.ok(ages[1] >= 40000 && ages[1] <= 43000, `the item's age by the time it is judged (the debounce moves the clock): ${ages[1]}`)
  assert.deepEqual(t.jira.calls.map((c) => c.key), ['ABC-123', 'ABC-123'])
  assert.deepEqual(t.acts().map((c) => c[1]).sort(), ['m1', 'm2'])
  const e = t.log().find((x) => x.itemId === 'm1')
  assert.equal(e.step, 'act')
  t.done()
})

test('a status the condition rejects: no act, a jira line in the log, the next rule takes the item', async () => {
  const jira = fakeJira({ 'ABC-123': { status: 'In Progress', category: 'indeterminate' } })
  const t = await setup({ jira, rules: [actRule('read'), rule('look', { sources: [SRC], when: [{ field: 'title', op: 'startsWith', value: '[JIRA]' }] })] })
  await t.push([mail('m1')])
  assert.deepEqual(t.acts(), [])
  assert.equal(t.ctx.opened.length, 1, 'the session rule below took it')
  const skip = t.log().find((e) => e.rule === 'project:read')
  assert.equal(skip.step, 'jira')
  assert.match(skip.skip, /^jira: jira\.status notIn In Progress, Backlog does not hold \(ABC-123: In Progress\)$/)
  t.done()
})

test('no provider, no key in the title, an unknown or forbidden key: false, logged, the next rule takes the item', async () => {
  const look = rule('look', { sources: [SRC], when: [{ field: 'title', op: 'startsWith', value: '[JIRA]' }] })
  // No jira provider.
  let t = await setup({ jira: null, rules: [actRule('read'), look] })
  await t.push([mail('m1')])
  assert.deepEqual(t.acts(), [])
  assert.equal(t.ctx.opened.length, 1)
  assert.match(t.log().find((e) => e.rule === 'project:read').skip, /^jira: no enabled plugin provides the jira service in this project \(bronos\.jira\): the rule does not hold/)
  // The status shows the missing provider as a warning, as reload does.
  const reload = await t.ctx.runCli(['reload'])
  assert.match(reload.stdout, /⚠ this rule has jira\.\* conditions, but no enabled plugin provides the jira service/)
  t.done()
  // No key.
  t = await setup({ rules: [actRule('read'), look] })
  await t.push([mail('m1', { title: '[JIRA] Digest of the week' })])
  assert.deepEqual(t.jira.calls, [])
  assert.match(t.log().find((e) => e.rule === 'project:read').skip, /^jira: no Jira issue key in the title: the rule does not hold/)
  assert.equal(t.ctx.opened.length, 1)
  t.done()
  // An unknown key ("not found (404)") and one the token may not see (403).
  t = await setup({ rules: [actRule('read'), look] })
  await t.push([mail('m1', { title: '[JIRA] (ZZZ-9) Gone' })])
  assert.equal(t.jira.calls.length, 1)
  assert.deepEqual(t.acts(), [])
  assert.match(t.log().find((e) => e.rule === 'project:read').skip, /^jira: issue ZZZ-9: not found \(404\): the rule does not hold/)
  assert.equal(t.ctx.opened.length, 1, 'the unknown key did not hold the item')
  t.jira.errors['ABC-123'] = new Error('jira: issue header: Jira says the token may not do this (403)')
  await t.push([mail('m2'), ...t.feed.items])
  assert.match(t.log().find((e) => e.itemId === 'm2' && e.rule === 'project:read').skip, /may not do this \(403\)/)
  t.done()
})

test('busy, too many and network errors are a retry, never a false: no lower rule fires; asked again in 10 minutes', async () => {
  const look = rule('look', { sources: [SRC], when: [{ field: 'title', op: 'startsWith', value: '[JIRA]' }], limits: { cooldownMinutes: 0 } })
  const t = await setup({ rules: [actRule('read'), look] })
  for (const msg of ['jira: busy, 2 lookups already running', 'jira: too many lookups in the last minute', 'jira: network: fetch failed']) {
    t.jira.error = new Error(msg)
    const id = `m-${msg.length}`
    const before = t.jira.calls.length
    await t.push([mail(id, { title: `[JIRA] (ABC-${msg.length}) Try` }), ...t.feed.items])
    assert.equal(t.jira.calls.length, before + 1)
    const e = t.log().find((x) => x.itemId === id)
    assert.equal(e.step, 'jira')
    assert.equal(e.rule, 'project:read')
    assert.ok(e.skip.includes(msg) && e.skip.endsWith('looked up again in 10 min, no lower rule fires meanwhile'), e.skip)
    t.jira.error = null
    t.jira.errors = {}
  }
  assert.equal(t.ctx.opened.length, 0, 'the session rule below fired on none of them')
  assert.deepEqual(t.acts(), [])
  t.done()
})

test('a retry is decided again after 10 minutes and then acts; a lookup that never works gives up after 4 tries', async () => {
  const t = await setup()
  t.jira.error = new Error('jira: busy, 2 lookups already running')
  await t.push([mail('m1')])
  assert.equal(t.jira.calls.length, 1)
  assert.deepEqual(t.acts(), [])
  // Not before the 10 minutes.
  await t.clock.advance(9 * 60000)
  await t.quiet()
  assert.equal(t.jira.calls.length, 1)
  t.jira.error = null
  await t.clock.advance(60000 + 1)
  await t.quiet()
  assert.equal(t.jira.calls.length, 2)
  assert.deepEqual(t.acts(), [['act', 'm1', 'markRead']])
  t.done()

  // A permanent failure: 4 tries (the first and three retries), then the condition is false, once.
  const u = await setup({ rules: [actRule('read'), rule('look', { sources: [SRC], when: [{ field: 'title', op: 'startsWith', value: '[JIRA]' }], limits: { cooldownMinutes: 0 } })] })
  u.jira.error = new Error('jira: network: fetch failed')
  await u.push([mail('m1')])
  for (let i = 0; i < 6; i++) {
    await u.clock.advance(10 * 60000 + 1)
    await u.quiet()
  }
  assert.equal(u.jira.calls.length, J.MAX_TRIES, 'not asked for ever')
  assert.deepEqual(u.acts(), [])
  assert.match(u.log().find((e) => e.rule === 'project:read' && /gave up/.test(e.skip || '')).skip, /gave up after 4 tries: the rule does not hold/)
  assert.equal(u.ctx.opened.length, 1, 'after giving up the next rule takes the item')
  u.done()
})

// ---- onChange on an act rule ----

test('onChange on an act rule: once per rev, each rev judged again; the same rev (marked read) is not run again', async () => {
  const jira = fakeJira({ 'ABC-123': { status: 'Backlog', category: 'new' } })
  const t = await setup({ jira, rules: [actRule('read', { onChange: true })] })
  // r1: the issue is in Backlog, the rule does not hold.
  await t.push([mail('m1', { rev: 'r1' })])
  assert.deepEqual(t.acts(), [])
  assert.equal(t.jira.calls.length, 1)
  // r2: a new rev, the issue moved on.
  t.jira.issues['ABC-123'] = { status: 'Done', category: 'done', done: true }
  await t.push([mail('m1', { rev: 'r2' })])
  assert.deepEqual(t.acts(), [['act', 'm1', 'markRead']])
  assert.equal(t.jira.calls.length, 2)
  // The act marked it read: the same rev again (a read change): nothing runs, nothing is looked up.
  await t.push([mail('m1', { rev: 'r2', read: true })])
  assert.equal(t.acts().length, 1, 'no loop')
  assert.equal(t.jira.calls.length, 2, 'a same-rev event costs no lookup')
  // r3: another message in the thread: it runs again.
  await t.push([mail('m1', { rev: 'r3' })])
  assert.equal(t.acts().length, 2)
  assert.equal(t.jira.calls.length, 3)
  t.done()
})

test('without onChange an act rule still runs on new items only', async () => {
  const jira = fakeJira({ 'ABC-123': { status: 'Backlog', category: 'new' } })
  const t = await setup({ jira, rules: [actRule('read')] })
  await t.push([mail('m1', { rev: 'r1' })])
  t.jira.issues['ABC-123'] = { status: 'Done', category: 'done', done: true }
  await t.push([mail('m1', { rev: 'r2' })])
  assert.deepEqual(t.acts(), [])
  assert.equal(t.jira.calls.length, 1, 'a change is no news to this rule: no lookup either')
  t.done()
})

test('limits count acts, not lookups', async () => {
  const jira = fakeJira({ 'ABC-123': { status: 'Backlog', category: 'new' } })
  const t = await setup({ jira, rules: [actRule('read', { onChange: true, limits: { perDay: 1, cooldownMinutes: 0 } })] })
  await t.push([mail('m1', { rev: 'r1' })])
  await t.push([mail('m1', { rev: 'r2' })])
  assert.equal(t.jira.calls.length, 2, 'two lookups that held nothing')
  t.jira.issues['ABC-123'] = { status: 'Done', category: 'done', done: true }
  await t.push([mail('m1', { rev: 'r3' })])
  assert.equal(t.acts().length, 1, 'the first act: the two lookups did not use the day\'s one')
  await t.push([mail('m1', { rev: 'r4' })])
  assert.equal(t.acts().length, 1)
  assert.match(t.log()[0].skip, /limit|perDay|a day/i)
  assert.equal(t.log()[0].step, 'limit')
  t.done()
})

// ---- the dry run ----

test('ccc autopilot test: the key found and "would look up" without --jira; with it the status got and the act', async () => {
  const t = await setup({ items: [mail('m1'), mail('m2', { title: '[JIRA] Digest of the week' }), mail('m3', { title: '[JIRA] (ZZZ-9) Gone' })] })
  const plain = await t.ctx.runCli(['test'])
  assert.equal(t.jira.calls.length, 0, 'nothing is looked up without --jira')
  assert.match(plain.stdout, /Jira not looked up: add --jira/)
  assert.match(plain.stdout, /m1 "\[JIRA\] \(ABC-123\) Fix the login redirect"\n {4}would not fire: would look up ABC-123 in Jira, read-only, to judge its jira\.\* conditions \(add --jira to do it\); no lower rule fires until it answers \(matched .*title names ABC-123\)/)
  assert.match(plain.stdout, /m2 .*\n {4}would not fire: jira: no Jira issue key in the title/)
  const real = await t.ctx.runCli(['test', '--jira'])
  assert.deepEqual(t.jira.calls.map((c) => c.key).sort(), ['ABC-123', 'ZZZ-9'])
  assert.match(real.stdout, /with Jira lookups/)
  assert.match(real.stdout, /m1 .*\n {4}would fire: would run markRead on the item \(no session\) \(matched .*issue ABC-123 is "Done", jira\.status notIn In Progress, Backlog\)/)
  assert.match(real.stdout, /m3 .*\n {4}would not fire: jira: issue ZZZ-9: not found \(404\)/)
  assert.deepEqual(t.acts(), [], 'the dry run acts on nothing')
  // A transient error shows as such, and holds the rows below.
  t.jira.error = new Error('jira: busy, 2 lookups already running')
  const busy = await t.ctx.runCli(['test', '--jira'])
  assert.match(busy.stdout, /m1 .*\n {4}would not fire: jira lookup of ABC-123 failed: jira: busy, 2 lookups already running; no lower rule fires \(looked up again in 10 min\)/)
  // A JSON rule is tested like a stored one.
  t.jira.error = null
  const j = await t.ctx.runCli(['test', JSON.stringify({ id: 'try', sources: [SRC], when: JIRA_WHEN, act: 'markRead' }), '--at', '1', '--jira'])
  assert.match(j.stdout, /m1 .*\n {4}would fire: would run markRead/)
  t.done()
})

test('the usage: --jira is a flag of test only, given once', () => {
  const CLI = require('../dist/lib/cli')
  assert.deepEqual(CLI.parse(['test', '--jira', '--jev', 'r1']), { cmd: 'test', rule: 'r1', jev: true, jira: true })
  assert.match(CLI.parse(['test', '--jira', '--jira']).error, /--jira given twice/)
  assert.match(CLI.HELP, /\[--jira\]/)
  assert.match(CLI.USAGE, /\[--jira\]/)
})
