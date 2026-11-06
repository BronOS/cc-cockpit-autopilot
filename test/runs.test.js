'use strict'
// One session per item (lib/runs.js and the host over it, design-v2 "One session per item"): the
// item→tab record and when it is dropped, the opening entry, a restart's re-adoption by sessionId,
// the slots (`maxRunning`), the queue, model and effort, the app-support signal, an early end.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAutopilot } = require('../dist/host')
const RUNS = require('../dist/lib/runs')
const { fakeCtx, fakeFeed, fakeClock, fakeStorage, item, settle, tempFolder, removeFolder, rule, NOW, JIRA } = require('./fakes')

const PLAYBOOKS = { check: '# Check the site\nOpen the status page and report.' }
const SRC = 'bronos.jira'

/** A switched-on host over one Jira feed, with a fake clock. `o.records`: stored runs before start. */
async function setup(o = {}) {
  const dir = tempFolder(o.rules || [rule('down', { limits: { cooldownMinutes: 0, perDay: 100 } })], PLAYBOOKS)
  const storage = fakeStorage()
  await storage.set('enabled', true)
  if (o.records) await storage.set(RUNS.KEY, o.records)
  const ctx = fakeCtx({ folder: dir, storage, noTyped: o.noTyped, settings: o.settings })
  for (const s of o.sessions || []) ctx.sessionList.push(s)
  const clock = fakeClock()
  const feed = fakeFeed(JIRA, o.items || [])
  ctx.addProvider(SRC, feed)
  const ap = createAutopilot(ctx, { now: clock.now, timers: clock.timers, debounceMs: 1000, home: '/home/ann' })
  await ap.first
  const t = { ctx, clock, feed, ap }
  t.push = async (items) => {
    feed.items = items
    ctx.emitFeed(SRC, 'sync', { items, state: 'ok', asOf: NOW })
    await settle()
    await clock.advance(1000)
    await t.idle()
  }
  t.idle = async () => {
    await settle()
    await ap.idle()
    await settle()
  }
  /** A tab moves on (status, sessionId, typed) and the host's onChange work is done. */
  t.set = async (tabId, patch) => {
    ctx.setSession(tabId, patch)
    await t.idle()
  }
  t.close = async (tabId) => {
    ctx.closeTab(tabId)
    await t.idle()
  }
  t.log = () => ap.state.recent()
  t.done = () => {
    ap.dispose()
    removeFolder(dir)
  }
  return t
}

const downs = (n, o = {}) => Array.from({ length: n }, (_, i) => item(`D${i + 1}`, { title: `site ${i + 1} down`, ...o }))

test('settings: maxRunning is a whole number 1..10 (default 3); myNames up to 10 trimmed strings', () => {
  const s = (project) => ({ project })
  assert.equal(RUNS.maxRunningOf(undefined), 3)
  assert.equal(RUNS.maxRunningOf(s({})), 3)
  assert.equal(RUNS.maxRunningOf(s({ maxRunning: 5 })), 5)
  assert.equal(RUNS.maxRunningOf(s({ maxRunning: 0 })), 1)
  assert.equal(RUNS.maxRunningOf(s({ maxRunning: 99 })), 10)
  assert.equal(RUNS.maxRunningOf(s({ maxRunning: 2.5 })), 3)
  assert.equal(RUNS.maxRunningOf(s({ maxRunning: '4' })), 3)
  assert.deepEqual(RUNS.myNamesOf(s({})), [])
  assert.deepEqual(RUNS.myNamesOf(s({ myNames: [' Ann Example ', '', 7, 'ann@example.com'] })), ['Ann Example', 'ann@example.com'])
  assert.equal(RUNS.myNamesOf(s({ myNames: Array.from({ length: 12 }, (_, i) => `n${i}`) })).length, 10)
  assert.deepEqual(RUNS.myNamesOf(s({ myNames: 'Ann' })), [])
})

test('records: a stored value is checked like any input; a bad entry is dropped', async () => {
  assert.equal(RUNS.recordOf({ source: SRC, itemId: 'A' }), null)
  assert.equal(RUNS.recordOf('x'), null)
  const r = RUNS.recordOf({ source: SRC, itemId: 'A', tabId: 't1', rule: 'down', openedAt: NOW, deliveries: -1, stopped: 'yes', sessionId: '', extra: 1 })
  assert.deepEqual(r, { source: SRC, itemId: 'A', tabId: 't1', sessionId: null, rule: 'down', rev: '', openedAt: NOW, deliveries: 0, stopped: false, runId: '', takenOver: false })
  const storage = fakeStorage()
  await storage.set(RUNS.KEY, [{ source: SRC, itemId: 'A', tabId: 't1', rule: 'down', openedAt: NOW }, { junk: true }, null])
  const runs = RUNS.createRuns({ storage, now: () => NOW })
  await runs.load()
  assert.deepEqual(runs.list().map((x) => x.itemId), ['A'])
})

test('the queue: one entry per key with its place kept, at most 50, the oldest out', () => {
  const runs = RUNS.createRuns({ storage: fakeStorage(), now: () => NOW })
  assert.equal(runs.enqueue(SRC, 'A'), null)
  runs.enqueue(SRC, 'B')
  assert.equal(runs.enqueue(SRC, 'A'), null, 'A again: nothing added')
  assert.deepEqual(runs.queued().map((q) => q.itemId), ['A', 'B'])
  for (let i = 0; i < 48; i++) runs.enqueue(SRC, `x${i}`)
  assert.equal(runs.queued().length, 50)
  assert.deepEqual(runs.enqueue(SRC, 'C'), { source: SRC, itemId: 'A', at: NOW, runId: null })
  assert.equal(runs.queued().length, 50)
  assert.equal(runs.queued()[0].itemId, 'B')
  assert.equal(runs.unqueue(SRC, 'B'), true)
  runs.clearQueue()
  assert.equal(runs.queued().length, 0)
  runs.enqueue(SRC, 'D', 'r0123456789ab')
  assert.deepEqual(runs.queuedOf(SRC, 'D'), { source: SRC, itemId: 'D', at: NOW, runId: 'r0123456789ab' }, 'the claim\'s run id rides along')
  assert.equal(runs.queuedOf(SRC, 'nope'), null)
})

test('one tab per item: the record, a new rev while the tab is open, a closed tab frees the item', async () => {
  const t = await setup({ rules: [rule('down', { onChange: true, model: 'sonnet', effort: 'high', limits: { cooldownMinutes: 0 } })] })
  await t.push([item('A', { title: 'site down', rev: 'a' })])
  assert.equal(t.ctx.opened.length, 1)
  // model and effort go to sessions.open; nothing else beside cwd and prompt (the tab opens unselected).
  assert.deepEqual(Object.keys(t.ctx.opened[0]).sort(), ['cwd', 'effort', 'model', 'prompt'])
  assert.deepEqual([t.ctx.opened[0].model, t.ctx.opened[0].effort], ['sonnet', 'high'])
  const [rec] = t.ap.runs.list()
  assert.deepEqual({ ...rec, openedAt: undefined, runId: undefined }, { source: SRC, itemId: 'A', tabId: 'tab-1', sessionId: null, rule: 'project:down', rev: 'a', openedAt: undefined, deliveries: 0, stopped: false, runId: undefined, takenOver: false, status: 'starting', pending: null })
  // The onChange frame carries the run's stop command with the recorded run id.
  assert.ok(t.ctx.opened[0].prompt.includes(`ccc autopilot stop ${rec.runId}`))
  // Stored, and the sessionId filled in when Claude reports it.
  await t.set('tab-1', { status: 'working', sessionId: 'sess-1' })
  assert.equal((await t.ctx.storage.get(RUNS.KEY))[0].sessionId, 'sess-1')
  await t.push([item('A', { title: 'site down', rev: 'b' })])
  assert.equal(t.ctx.opened.length, 1, 'the tab exists: no second session')
  assert.deepEqual([t.log()[0].step, t.log()[0].note], ['update', 'updated (rev b): pending for tab tab-1, sent when Claude waits for input'])
  // A finished tab (waiting) still owns the item; the update goes into it then.
  await t.set('tab-1', { status: 'waiting' })
  assert.equal(t.ctx.sent.length, 1)
  await t.set('tab-1', { status: 'working' })
  await t.push([item('A', { title: 'site down', rev: 'c' })])
  assert.equal(t.ctx.opened.length, 1)
  const d = await t.ap.dryRun(null, false)
  assert.equal(d.results[0].verdict, 'its tab tab-1 is open (rule project:down): no second session')
  await t.close('tab-1')
  assert.deepEqual(t.ap.runs.list(), [])
  assert.deepEqual(await t.ctx.storage.get(RUNS.KEY), [])
  assert.deepEqual([t.log()[0].step, t.log()[0].note], ['run', 'tab tab-1 closed: the item is free'])
  await t.push([item('A', { title: 'site down', rev: 'd' })])
  assert.equal(t.ctx.opened.length, 2, 'free again: the next rev goes through the rules')
  assert.match(t.ctx.opened[1].prompt, /id: A/)
  assert.equal(t.ap.runs.runOf(SRC, 'A').record.rev, 'd')
  t.done()
})

test('a rule without model or effort leaves both out of sessions.open', async () => {
  const t = await setup()
  await t.push([item('A', { title: 'site down' })])
  assert.deepEqual(Object.keys(t.ctx.opened[0]).sort(), ['cwd', 'prompt'])
  t.done()
})

test('a second rev while the tab is opening opens nothing', async () => {
  const t = await setup({ rules: [rule('down', { onChange: true, limits: { cooldownMinutes: 0 } })] })
  const release = t.ctx.holdOpen()
  // Not t.push: its idle() would wait for the judging, which waits for the held open.
  t.feed.items = [item('A', { title: 'site down', rev: 'a' })]
  t.ctx.emitFeed(SRC, 'sync', { items: t.feed.items, state: 'ok', asOf: NOW })
  await settle()
  await t.clock.advance(1000)
  // The judging reads real files (both rules folders, the playbook) before it opens: under a loaded test
  // run that can take longer than one settle, so wait (bounded) for the opening entry.
  for (let i = 0; i < 100 && !t.ap.runs.runOf(SRC, 'A'); i++) await settle()
  assert.equal(t.ctx.opened.length, 0, 'open() in flight')
  assert.equal(t.ap.runs.runOf(SRC, 'A').kind, 'opening')
  assert.equal(t.ap.runs.running(), 1, 'an opening entry holds a slot')
  t.feed.items = [item('A', { title: 'site down', rev: 'b' })]
  t.ctx.emitFeed(SRC, 'sync', { items: t.feed.items, state: 'ok', asOf: NOW })
  await settle()
  await t.clock.advance(1000)
  release()
  await t.idle()
  assert.equal(t.ctx.opened.length, 1)
  assert.equal(t.ap.runs.runOf(SRC, 'A').kind, 'tab')
  assert.equal(t.log()[0].step, 'update')
  t.done()
})

test('a stale record never blocks an item: a tab that never showed is dropped after its grace', async () => {
  const t = await setup()
  // An app that answered a tab id it never lists (a window closing under the open, say).
  t.ctx.sessions.open = ((open) => async (o) => {
    const r = await open(o)
    t.ctx.sessionList.pop()
    return r
  })(t.ctx.sessions.open)
  await t.push([item('A', { title: 'site down' })])
  assert.equal(t.ap.runs.list().length, 1, 'just opened: the list may be a moment late')
  await t.clock.advance(RUNS.FRESH_MS)
  await t.ap.tick()
  assert.equal(t.ap.runs.list().length, 0)
  assert.match(t.log()[0].note, /tab tab-1 closed/)
  t.done()
})

test('restart: a record is re-adopted by sessionId on the restored tab, taken over; one with no tab is dropped', async () => {
  const records = [
    { source: SRC, itemId: 'A', tabId: 'old-1', sessionId: 'sess-a', rule: 'project:down', rev: 'a', openedAt: NOW - 3600000, deliveries: 1, stopped: false, runId: 'r1' },
    { source: SRC, itemId: 'B', tabId: 'old-2', sessionId: 'sess-b', rule: 'project:down', rev: 'a', openedAt: NOW - 3600000, runId: 'r2' },
  ]
  // A restored tab: a new tab id, the same Claude session; typed: false (0.11 does not persist it).
  const t = await setup({ records, items: [item('A', { title: 'site down', rev: 'a' }), item('B', { title: 'site down', rev: 'a' })], sessions: [{ tabId: 'tab-9', status: 'waiting', cwd: '/work/project', sessionId: 'sess-a', typed: false }] })
  await t.push([item('A', { title: 'site down', rev: 'b' }), item('B', { title: 'site down', rev: 'a' })])
  const a = t.ap.runs.runOf(SRC, 'A')
  assert.deepEqual([a.record.tabId, a.record.takenOver, a.record.deliveries], ['tab-9', true, 1])
  assert.equal(t.ctx.opened.length, 0, 'A stays bound to its restored tab')
  assert.ok(t.log().some((e) => e.itemId === 'A' && /restored tab tab-9 re-adopted/.test(e.note || '')))
  // B's tab did not come back (yet): kept for the restore grace, then dropped.
  assert.ok(t.ap.runs.runOf(SRC, 'B'))
  assert.equal(t.ap.runs.running(), 0, 'restored and unconfirmed records hold no slot (A is waiting)')
  await t.clock.advance(RUNS.RESTORE_GRACE_MS)
  await t.ap.tick()
  assert.equal(t.ap.runs.runOf(SRC, 'B'), null)
  assert.deepEqual((await t.ctx.storage.get(RUNS.KEY)).map((r) => [r.itemId, r.tabId, r.takenOver]), [['A', 'tab-9', true]])
  // The restored tab holds a slot only while it works.
  await t.set('tab-9', { status: 'working' })
  assert.equal(t.ap.runs.running(), 1)
  t.done()
})

test('the cap: a burst of 5 opens 3, the rest queue; a finished, permission-waiting or ended tab frees a slot', async () => {
  const t = await setup()
  await t.push(downs(5))
  assert.equal(t.ctx.opened.length, 3, 'starting tabs hold their slots: no burst past the cap')
  assert.deepEqual(t.ap.runs.queued().map((q) => q.itemId), ['D4', 'D5'])
  const queued = t.log().filter((e) => e.step === 'cap')
  assert.equal(queued.length, 2)
  assert.match(queued[0].skip, /^queued: 3 Autopilot sessions running \(maxRunning 3\)/)
  assert.deepEqual(t.ap.status().queued.map((q) => q.itemId), ['D4', 'D5'])
  assert.deepEqual([t.ap.status().slots, t.ap.status().maxRunning], [3, 3])
  await t.set('tab-1', { status: 'working' })
  assert.equal(t.ctx.opened.length, 3, 'working still holds')
  await t.set('tab-1', { status: 'waiting' })
  assert.equal(t.ctx.opened.length, 4, 'finished: the oldest queued item opens')
  assert.match(t.ctx.opened[3].prompt, /id: D4/)
  await t.set('tab-2', { status: 'needs-permission' })
  assert.equal(t.ctx.opened.length, 5)
  assert.match(t.ctx.opened[4].prompt, /id: D5/)
  assert.deepEqual(t.ap.runs.queued(), [])
  // Ended frees a slot too, and the item stays bound to the ended tab until it is closed.
  await t.set('tab-3', { status: 'ended' })
  assert.equal(t.ap.runs.running(), 2)
  assert.ok(t.ap.runs.runOf(SRC, 'D3'))
  t.done()
})

test('maxRunning from the project setting; the global limit still logs and never queues', async () => {
  const t = await setup({ settings: { maxRunning: 1 } })
  await t.push(downs(2))
  assert.equal(t.ctx.opened.length, 1)
  assert.equal(t.ap.runs.queued().length, 1)
  t.done()
  const lim = await setup({ rules: [rule('down', { limits: { perDay: 1, cooldownMinutes: 0 } })], settings: { maxRunning: 1 } })
  await lim.push(downs(2))
  assert.equal(lim.ctx.opened.length, 1)
  assert.deepEqual(lim.ap.runs.queued(), [], 'refused by a limit: logged, not queued')
  assert.equal(lim.log()[0].step, 'limit')
  lim.done()
})

test('the queue: one entry per key, re-checked with the latest copy (gone, read, new rev) when a slot frees', async () => {
  const unread = { field: 'read', op: 'is', value: false }
  const t = await setup({ settings: { maxRunning: 1 }, rules: [rule('down', { when: [{ field: 'title', op: 'contains', value: 'down' }, unread], limits: { cooldownMinutes: 0, perDay: 100 } })] })
  await t.push(downs(4, { rev: 'r1' }))
  assert.equal(t.ctx.opened.length, 1)
  assert.deepEqual(t.ap.runs.queued().map((q) => q.itemId), ['D2', 'D3', 'D4'])
  // A newer rev of a queued item: still one entry, in its place, and one "queued" line.
  await t.push([...downs(1, { rev: 'r1' }), item('D2', { title: 'site 2 down', rev: 'r2' }), ...downs(4, { rev: 'r1' }).slice(2)])
  assert.deepEqual(t.ap.runs.queued().map((q) => q.itemId), ['D2', 'D3', 'D4'])
  assert.equal(t.log().filter((e) => e.step === 'cap' && e.itemId === 'D2').length, 1)
  // Meanwhile D3 left its feed and D4 was read. Pushed with no new news (D2 r2 the same).
  t.feed.items = [...downs(1, { rev: 'r1' }), item('D2', { title: 'site 2 down', rev: 'r2' }), item('D4', { title: 'site 4 down', rev: 'r1', read: true })]
  t.ctx.emitFeed(SRC, 'sync', { items: t.feed.items, state: 'ok', asOf: NOW })
  await t.idle()
  await t.set('tab-1', { status: 'waiting' })
  assert.equal(t.ctx.opened.length, 2)
  assert.match(t.ctx.opened[1].prompt, /id: D2/)
  assert.equal(t.ap.runs.runOf(SRC, 'D2').record.rev, 'r2', 'the latest copy opens')
  assert.deepEqual(t.ap.runs.queued().map((q) => q.itemId), ['D3', 'D4'], 'the cap is full again')
  await t.set('tab-2', { status: 'waiting' })
  assert.equal(t.ctx.opened.length, 2, 'D3 is gone, D4 is read: neither opens')
  assert.deepEqual(t.ap.runs.queued(), [])
  assert.ok(t.log().some((e) => e.itemId === 'D3' && e.skip === 'left its feed while queued: not opened'))
  // Switching off empties the queue.
  await t.push([...t.feed.items, ...downs(6, { rev: 'r1' }).slice(4)])
  assert.ok(t.ap.runs.queued().length >= 1)
  await t.ap.setEnabled(false)
  assert.deepEqual(t.ap.runs.queued(), [])
  t.done()
})

test('a tab that ends right after opening is logged with its rule', async () => {
  const t = await setup({ rules: [rule('down', { model: 'opus', limits: { cooldownMinutes: 0 } })] })
  await t.push([item('A', { title: 'site down' })])
  await t.set('tab-1', { status: 'ended' })
  assert.deepEqual([t.log()[0].rule, t.log()[0].step], ['project:down', 'run'])
  assert.match(t.log()[0].note, /tab tab-1 ended within a minute of opening: check the rule's model and effort/)
  await t.set('tab-1', { title: 'x' })
  assert.equal(t.log().filter((e) => /ended within/.test(e.note || '')).length, 1, 'once')
  t.done()
})

test('app support: unknown with no Claude tab, yes with typed, no on an older app (the model note)', async () => {
  const r = [rule('down', { model: 'haiku', limits: { cooldownMinutes: 0 } })]
  const t = await setup({ rules: r })
  assert.equal(t.ap.status().takeover, 'unknown')
  assert.deepEqual(t.ap.status().rules[0].warnings.filter((w) => /0\.11/.test(w)), [], 'not claimed while unknown')
  await t.push([item('A', { title: 'site down' })])
  assert.equal(t.ap.status().takeover, 'yes')
  t.done()
  const old = await setup({ rules: r, noTyped: true })
  await old.push([item('A', { title: 'site down' })])
  assert.equal(old.ap.status().takeover, 'no')
  assert.ok(old.ap.status().rules[0].warnings.some((w) => /model and effort need cc-cockpit 0\.11/.test(w)))
  old.done()
})

// ---- updates into the item's tab, takeover and stop (plan Task 12, design-v2 "While the item's tab exists") ----

const OC = [rule('down', { onChange: true, limits: { cooldownMinutes: 0, perDay: 100 } })]
const down = (rev, o = {}) => item('A', { title: 'site down', rev, ...o })
/** An onChange host with item A's tab open and working (tab-1). */
async function running(o = {}) {
  const t = await setup({ rules: OC, ...o })
  await t.push([down('a')])
  assert.equal(t.ctx.opened.length, 1)
  await t.set('tab-1', { status: 'working', sessionId: 'sess-1' })
  t.runId = t.ap.runs.list()[0].runId
  return t
}
const rec = (t) => t.ap.runs.list()[0]

test('updates merge to one pending (newest wins), delivered once when the tab waits', async () => {
  const t = await running()
  await t.push([down('b')])
  await t.push([down('c')])
  assert.equal(t.ctx.sent.length, 0, 'working: nothing typed')
  assert.equal(rec(t).pending, 'c')
  assert.equal(t.log()[0].note, 'updated (rev c): pending for tab tab-1, sent when Claude waits for input; replaces rev b')
  await t.set('tab-1', { status: 'waiting' })
  assert.equal(t.ctx.sent.length, 1, 'one delivery of the latest state')
  const [s] = t.ctx.sent
  assert.equal(s.tabId, 'tab-1')
  assert.equal(s.status, 'waiting')
  assert.match(s.text, /^Autopilot: the item changed \(now rev c\)/)
  assert.ok(s.text.includes(`ccc autopilot stop ${t.runId}`))
  assert.match(s.text, /bronos\.jira/, 'the source is named')
  assert.deepEqual([rec(t).deliveries, rec(t).rev, rec(t).pending], [1, 'c', null])
  assert.equal(t.log()[0].note, 'update rev c delivered into tab tab-1 (1 of 5)')
  // Another onChange while still waiting sends nothing more (nothing pending).
  await t.set('tab-1', { status: 'waiting', title: 'x' })
  assert.equal(t.ctx.sent.length, 1)
  // A rev that comes while the tab already waits goes at once.
  await t.push([down('d')])
  assert.equal(t.ctx.sent.length, 2)
  assert.match(t.ctx.sent[1].text, /now rev d/)
  t.done()
})

test('delivered only when waiting: starting, working and permission-waiting tabs keep it pending', async () => {
  const t = await setup({ rules: OC })
  await t.push([down('a')])
  await t.push([down('b')])
  // ('ended' is not in the list: an ended tab releases the item's claim, see claims.test.js.)
  for (const status of ['starting', 'working', 'needs-permission', 'idle']) {
    await t.set('tab-1', { status })
    assert.equal(t.ctx.sent.length, 0, status)
    assert.equal(rec(t).pending, 'b', status)
  }
  await t.set('tab-1', { status: 'waiting' })
  assert.equal(t.ctx.sent.length, 1)
  t.done()
})

test('a rev while the tab is opening becomes its pending update, sent once the tab waits', async () => {
  const t = await setup({ rules: OC })
  const release = t.ctx.holdOpen()
  t.feed.items = [down('a')]
  t.ctx.emitFeed(SRC, 'sync', { items: t.feed.items, state: 'ok', asOf: NOW })
  await settle()
  await t.clock.advance(1000)
  t.feed.items = [down('b')]
  t.ctx.emitFeed(SRC, 'sync', { items: t.feed.items, state: 'ok', asOf: NOW })
  await settle()
  await t.clock.advance(1000)
  release()
  await t.idle()
  // Judging is one batch at a time, so rev b is decided once the open resolved: pending for the tab.
  assert.match(t.log().find((e) => e.step === 'update').note, /^updated \(rev b\): pending for tab tab-1/)
  await t.set('tab-1', { status: 'waiting' })
  assert.equal(t.ctx.sent.length, 1)
  assert.match(t.ctx.sent[0].text, /now rev b/)
  t.done()
})

test('typed: the pending update is dropped, the tab is taken over for good (stored), nothing more is sent', async () => {
  const t = await running()
  await t.push([down('b')])
  await t.set('tab-1', { typed: true })
  assert.deepEqual([rec(t).takenOver, rec(t).pending], [true, null])
  assert.equal((await t.ctx.storage.get(RUNS.KEY))[0].takenOver, true)
  assert.equal(t.log()[0].note, 'taken over: you typed in tab tab-1; nothing more is delivered into it (pending update rev b dropped)')
  await t.set('tab-1', { status: 'waiting' })
  await t.push([down('c')])
  assert.equal(t.ctx.sent.length, 0)
  assert.equal(t.log()[0].skip, 'updated (rev c), taken over: you typed in the tab; nothing sent')
  t.done()
})

test('a send main refuses is logged and the update dropped (no retry, no delivery counted)', async () => {
  const t = await running()
  await t.push([down('b')])
  t.ctx.sendError = 'the person is typing in this tab'
  await t.set('tab-1', { status: 'waiting' })
  assert.equal(t.log()[0].skip, 'update rev b for tab tab-1: send refused: the person is typing in this tab; dropped')
  assert.deepEqual([rec(t).pending, rec(t).deliveries, rec(t).rev], [null, 0, 'a'])
  await t.set('tab-1', { status: 'waiting', title: 'again' })
  assert.equal(t.ctx.sent.length, 0)
  t.done()
})

test('unknown support sends nothing until a Claude tab tells; an older app (no typed) never gets an update', async () => {
  const t = await setup({ rules: OC })
  // The new tab is not listed yet (and no onChange told of it): no Claude tab, support unknown.
  const emit = t.ctx.emitSessions
  t.ctx.emitSessions = () => {}
  t.ctx.sessions.open = ((open) => async (o) => {
    const r = await open(o)
    t.ctx.sessionList.pop()
    return r
  })(t.ctx.sessions.open)
  await t.push([down('a')])
  await t.push([down('b')])
  t.ctx.emitSessions = emit
  assert.equal(t.ap.status().takeover, 'unknown')
  assert.equal(rec(t).pending, 'b', 'kept while unknown')
  await t.ap.tick()
  assert.equal(t.ctx.sent.length, 0)
  // The tab shows up waiting: support yes, the update goes.
  t.ctx.addSession({ tabId: 'tab-1', status: 'waiting' })
  await t.idle()
  assert.equal(t.ctx.sent.length, 1)
  t.done()

  const old = await setup({ rules: OC, noTyped: true })
  await old.push([down('a')])
  await old.set('tab-1', { status: 'waiting' })
  await old.push([down('b')])
  assert.equal(old.ctx.sent.length, 0)
  assert.equal(old.log()[0].skip, 'updated (rev b), tab tab-1 open: nothing sent (this app does not report typing in a tab: updates need cc-cockpit 0.11)')
  assert.equal(rec(old).pending, null)
  old.done()
})

test('at most 5 deliveries into one tab, then "delivery cap"', async () => {
  const t = await running()
  for (let i = 1; i <= 6; i++) {
    await t.push([down(`v${i}`)])
    await t.set('tab-1', { status: 'waiting' })
    await t.set('tab-1', { status: 'working' })
  }
  assert.equal(t.ctx.sent.length, RUNS.DELIVERY_MAX)
  assert.equal(rec(t).deliveries, 5)
  assert.equal(t.log().find((e) => e.skip).skip, 'updated (rev v6), delivery cap: 5 updates were delivered into this tab; nothing sent')
  t.done()
})

test('own reply (myNames, case-insensitive on from.name / from.address) is logged, not delivered; empty myNames: no check', async () => {
  const t = await running({ settings: { myNames: [' Ann@example.com '] } })
  await t.push([down('b', { extra: { from: { name: 'Ann E.', address: 'ANN@example.com' } } })])
  assert.equal(t.log()[0].skip, 'updated (rev b), your reply: not delivered')
  assert.equal(rec(t).pending, null)
  await t.push([down('c', { extra: { from: { name: 'Bob', address: 'bob@example.com' } } })])
  assert.equal(rec(t).pending, 'c')
  t.done()
  assert.equal(RUNS.isOwn(down('x', { from: 'Ann Example' }), []), false, 'no names: off')
  assert.equal(RUNS.isOwn(down('x', { from: 'ann example' }), ['Ann Example']), true)
  assert.equal(RUNS.isOwn({ id: 'x', rev: '1', title: 't' }, ['Ann Example']), false, 'no from')
})

test('no onChange, a rule switched off or gone: logged, nothing pending', async () => {
  const t = await running()
  // The rule loses onChange in the file: the item's tab gets nothing more.
  const fs = require('node:fs')
  const path = require('node:path')
  const file = path.join(t.ctx.settings.project.projectFolder, 'autopilot-rules.json')
  fs.writeFileSync(file, JSON.stringify([{ ...OC[0], onChange: false }]))
  await t.push([down('b')])
  assert.equal(t.log()[0].skip, 'updated (rev b), tab tab-1 open: nothing sent')
  fs.writeFileSync(file, JSON.stringify([{ ...OC[0], enabled: false }]))
  await t.push([down('c')])
  assert.equal(t.log()[0].skip, 'updated (rev c), tab tab-1 open: nothing sent (rule project:down is off)')
  assert.equal(rec(t).pending, null)
  t.done()
})

test('switching off drops the pending updates', async () => {
  const t = await running()
  await t.push([down('b')])
  await t.ap.setEnabled(false)
  assert.equal(rec(t).pending, null)
  t.done()
})

test('ccc autopilot stop <run>: only from the run\'s own tab; then nothing more is delivered', async () => {
  const t = await running()
  t.ctx.addSession({ tabId: 'tab-9', status: 'waiting' })
  await t.idle()
  await t.push([down('b')])
  const none = await t.ctx.runCli(['stop', t.runId])
  assert.equal(none.code, 1)
  assert.match(none.stderr, /only from the run's own Claude tab/)
  const other = await t.ctx.runCli(['stop', t.runId], 'tab-9')
  assert.equal(other.code, 1)
  assert.equal(other.stderr, `No Autopilot run ${t.runId} in this tab.\n`)
  assert.match(t.log()[0].note, /refused: tab tab-9 is not that run's tab/)
  const unknown = await t.ctx.runCli(['stop', 'r000000000000'], 'tab-1')
  assert.equal(unknown.code, 1)
  assert.equal(rec(t).stopped, false)
  assert.equal(rec(t).pending, 'b')
  const ok = await t.ctx.runCli(['stop', t.runId], 'tab-1')
  assert.equal(ok.code, undefined)
  assert.equal(ok.stdout, `Autopilot run ${t.runId} stopped: nothing more is sent to this tab.\n`)
  assert.deepEqual([rec(t).stopped, rec(t).pending], [true, null])
  assert.equal((await t.ctx.storage.get(RUNS.KEY))[0].stopped, true)
  assert.match(t.log()[0].note, /stopped by its session/)
  await t.set('tab-1', { status: 'waiting' })
  await t.push([down('c')])
  assert.equal(t.ctx.sent.length, 0)
  assert.equal(t.log()[0].skip, 'updated (rev c), stopped: the session ran ccc autopilot stop; nothing sent')
  // Again: still fine, logged once.
  assert.equal((await t.ctx.runCli(['stop', t.runId], 'tab-1')).code, undefined)
  t.done()
})
