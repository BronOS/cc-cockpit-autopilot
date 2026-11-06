'use strict'
// The host end to end over fakes: baselines (start, switch-on, a provider joining, a source that
// failed first), once per rev, limits, the Jev step, the prompt and log of a fire, the folder read
// fresh, the panel. A fake clock drives the debounce: no real timers.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createAutopilot } = require('../dist/host')
const { fakeCtx, fakeFeed, fakeJev, fakeClock, fakeStorage, item, settle, drive, tempFolder, removeFolder, rule, NOW, MIN, HOUR, CHAT, MAIL, JIRA } = require('./fakes')

const PLAYBOOKS = { check: '# Check the site\nOpen the status page and report.' }

/** A host over a temp folder, with a fake clock, the debounce at 1 s. `o.on`: stored switched on. */
async function setup(o = {}) {
  const dir = o.dir || tempFolder(o.rules || [rule('down')], o.playbooks || PLAYBOOKS)
  const storage = o.storage || fakeStorage()
  if (o.on) await storage.set('enabled', true)
  const ctx = fakeCtx({ folder: dir, globalFolder: o.globalDir, jev: o.jev, storage, old: o.old, noTyped: o.noTyped, settings: o.settings })
  const clock = fakeClock()
  const feeds = {}
  for (const [id, feed] of Object.entries(o.feeds || {})) {
    feeds[id] = feed
    ctx.addProvider(id, feed)
  }
  const ap = createAutopilot(ctx, { now: clock.now, timers: clock.timers, debounceMs: 1000, home: '/home/ann' })
  await ap.first
  const t = { ctx, clock, feeds, ap, dir }
  /** The feed's whole list changes: a `sync` event (what a source sends on any state change), the judging done. */
  t.push = async (id, items) => {
    feeds[id].items = items
    ctx.emitFeed(id, 'sync', { items, state: 'ok', asOf: NOW })
    await settle()
    await clock.advance(1000)
    await ap.idle()
    // A Jev request the judging queued goes out on lib/jev.js's timer (at once, or 2 s after the last
    // grid of that question); its answer's decision is queued work again.
    await clock.advance(2000)
    await settle()
    await ap.idle()
    await settle()
  }
  t.done = () => {
    ap.dispose()
    if (!o.dir) removeFolder(dir)
  }
  return t
}

const logOf = (t) => t.ap.state.recent()

test('start: items already in the feeds never fire, even when stored on; new ones do', async () => {
  const jira = fakeFeed(JIRA, [item('SUP-1', { title: 'Site down' }), item('SUP-2', { title: 'Also down' })])
  const t = await setup({ on: true, feeds: { 'bronos.jira': jira } })
  assert.equal(t.ctx.opened.length, 0, 'no burst at start')
  await t.push('bronos.jira', [item('SUP-3', { title: 'Shop DOWN on example.com' }), ...jira.items])
  assert.equal(t.ctx.opened.length, 1)
  const o = t.ctx.opened[0]
  assert.equal(o.cwd, '/work/project')
  assert.match(o.prompt, /^You were started by Autopilot for the rule "project:down"/)
  assert.match(o.prompt, /<<<ITEM ([0-9a-f]{16})>>> source: bronos.jira \| id: SUP-3 \| .*title: Shop DOWN on example.com <<<END \1>>>/)
  assert.ok(o.prompt.endsWith('# Check the site\nOpen the status page and report.\n'))
  assert.deepEqual(t.ctx.notes.map((n) => n.text), ['Autopilot: project:down for Shop DOWN on example.com'])
  const [e] = logOf(t)
  assert.deepEqual({ ...e, at: undefined, runId: undefined }, { at: undefined, rule: 'project:down', source: 'bronos.jira', itemId: 'SUP-3', title: 'Shop DOWN on example.com', step: 'rule', tabId: 'tab-1', runId: undefined })
  // The run id in the log is the one the record keeps (lib/runs.js); the frame of a rule without
  // onChange has no stop line, so the id is not in this prompt.
  assert.match(e.runId, /^r[0-9a-f]{12}$/)
  assert.equal(t.ap.runs.list()[0].runId, e.runId)
  t.done()
})

test('switch-on takes a baseline: what came in while off never fires', async () => {
  const chat = fakeFeed(CHAT, [])
  const t = await setup({ feeds: { 'bronos.chat': chat } })
  await t.push('bronos.chat', [item('m1', { title: 'db down' })])
  assert.equal(t.ctx.opened.length, 0, 'off: nothing fires')
  // An item that came in while off (an `item` event): tracked, so it is part of the baseline.
  chat.items = [item('m2', { title: 'api down' }), ...chat.items]
  t.ctx.emitFeed('bronos.chat', 'item', chat.items[0])
  await settle()
  await t.ap.setEnabled(true)
  assert.equal(t.ctx.opened.length, 0)
  assert.match(logOf(t)[0].note, /switched on; baseline: 2 items/)
  await t.push('bronos.chat', [item('m3', { title: 'web down' }), ...chat.items])
  assert.deepEqual(t.ctx.opened.length, 1)
  assert.match(t.ctx.opened[0].prompt, /id: m3/)
  await t.ap.setEnabled(false)
  await t.push('bronos.chat', [item('m4', { title: 'cdn down' }), ...chat.items])
  assert.equal(t.ctx.opened.length, 1, 'off again')
  assert.equal(await t.ctx.storage.get('enabled'), false)
  t.done()
})

test('a provider that joins later, or a source that failed first, starts with a baseline', async () => {
  const chat = fakeFeed(CHAT, [])
  const t = await setup({ on: true, feeds: { 'bronos.chat': chat } })
  const jira = fakeFeed(JIRA, [item('SUP-9', { title: 'down since noon' })])
  t.feeds['bronos.jira'] = jira
  t.ctx.addProvider('bronos.jira', jira)
  await settle()
  await t.ap.idle()
  assert.equal(t.ctx.opened.length, 0)
  // A signed-out source with nothing: no baseline yet; its first good answer is one.
  const mail = fakeFeed(MAIL, [])
  mail.state = 'signedOut'
  t.feeds['bronos.gmail'] = mail
  t.ctx.addProvider('bronos.gmail', mail)
  await settle()
  mail.state = 'ok'
  await t.push('bronos.gmail', [item('th1', { title: 'is the site down?' })])
  assert.equal(t.ctx.opened.length, 0)
  await t.push('bronos.gmail', [item('th2', { title: 'site down again' }), ...mail.items])
  assert.equal(t.ctx.opened.length, 1)
  t.done()
})

test('once per item: a new rev does not fire again, unless the rule has onChange', async () => {
  const jira = fakeFeed(JIRA, [])
  const t = await setup({ on: true, feeds: { 'bronos.jira': jira }, rules: [rule('once', { limits: { cooldownMinutes: 0 } }), rule('again', { when: [{ field: 'title', op: 'contains', value: 'outage' }], onChange: true, limits: { cooldownMinutes: 0 } })] })
  await t.push('bronos.jira', [item('SUP-1', { title: 'site down', rev: 'a' }), item('SUP-2', { title: 'outage', rev: 'a' })])
  assert.equal(t.ctx.opened.length, 2)
  // Both tabs still open: a new rev goes to the item's run (logged until plan Task 12), never a second tab.
  await t.push('bronos.jira', [item('SUP-1', { title: 'site down', rev: 'b' }), item('SUP-2', { title: 'outage', rev: 'b' })])
  assert.equal(t.ctx.opened.length, 2)
  assert.deepEqual(logOf(t).slice(0, 2).map((e) => [e.itemId, e.step]), [['SUP-2', 'update'], ['SUP-1', 'update']])
  // The person closed both tabs: the items are free; once per item still holds for the rule without onChange.
  t.ctx.closeTab('tab-1')
  t.ctx.closeTab('tab-2')
  await settle()
  await t.ap.idle()
  await t.push('bronos.jira', [item('SUP-1', { title: 'site down', rev: 'c' }), item('SUP-2', { title: 'outage', rev: 'c' })])
  assert.equal(t.ctx.opened.length, 3, 'only the onChange rule fires on the new rev')
  assert.match(t.ctx.opened[2].prompt, /id: SUP-2/)
  // The same rev listed again (after dropping out) does not fire.
  t.ctx.closeTab('tab-3')
  await settle()
  await t.push('bronos.jira', [])
  await t.push('bronos.jira', [item('SUP-2', { title: 'outage', rev: 'c' })])
  assert.equal(t.ctx.opened.length, 3)
  t.done()
})

test('limits: perDay and cooldown per rule, 10 an hour for all rules, each skip logged', async () => {
  const jira = fakeFeed(JIRA, [])
  const rules = [rule('daily', { limits: { perDay: 2, cooldownMinutes: 0 } }), rule('cool', { when: [{ field: 'title', op: 'contains', value: 'slow' }], limits: { perDay: 50, cooldownMinutes: 30 } })]
  // maxRunning 10: the cap on running sessions is not what this test is about.
  const t = await setup({ on: true, feeds: { 'bronos.jira': jira }, rules, settings: { maxRunning: 10 } })
  const list = []
  const add = async (it) => {
    list.unshift(it)
    await t.push('bronos.jira', [...list])
  }
  await add(item('d1', { title: 'down 1' }))
  await add(item('d2', { title: 'down 2' }))
  await add(item('d3', { title: 'down 3' }))
  assert.equal(t.ctx.opened.length, 2)
  assert.deepEqual([logOf(t)[0].step, logOf(t)[0].itemId], ['limit', 'd3'])
  assert.match(logOf(t)[0].skip, /perDay 2/)
  await add(item('s1', { title: 'slow 1' }))
  await t.clock.advance(5 * MIN)
  await add(item('s2', { title: 'slow 2' }))
  assert.equal(t.ctx.opened.length, 3)
  assert.match(logOf(t)[0].skip, /cooldown/)
  // The global cap: 10 opens in the hour from any rule.
  const many = await setup({ on: true, feeds: { 'bronos.jira': fakeFeed(JIRA, []) }, rules: [rule('flood', { limits: { perDay: 100, cooldownMinutes: 0 } })], settings: { maxRunning: 10 } })
  // Each tab finishes at once (waiting holds no slot), so only the global limit stops the eleventh.
  many.ctx.sessions.open = ((open) => async (o) => {
    const r = await open(o)
    many.ctx.sessionList.at(-1).status = 'waiting'
    return r
  })(many.ctx.sessions.open)
  await many.push('bronos.jira', Array.from({ length: 12 }, (_, i) => item(`f${i}`, { title: `down ${i}` })))
  assert.equal(many.ctx.opened.length, 10)
  assert.equal(many.ap.state.recent().filter((e) => e.step === 'limit').length, 2)
  assert.match(many.ap.state.recent()[0].skip, /10 sessions in the last hour/)
  many.done()
  t.done()
})

test('jev step: yes opens (logged with the score), no is a logged skip, unavailable a logged retry', async () => {
  const jev = fakeJev(0.91)
  const jira = fakeFeed(JIRA, [])
  const rules = [rule('asked', { jev: { question: 'Is a website down?', min: 0.7 }, limits: { cooldownMinutes: 0 } })]
  const t = await setup({ on: true, jev, feeds: { 'bronos.jira': jira }, rules })
  await t.push('bronos.jira', [item('SUP-1', { title: 'site down', preview: 'example.com returns 502', where: 'Support', from: 'Ann Example' })])
  assert.equal(t.ctx.opened.length, 1)
  assert.deepEqual(jev.calls[0].questions, { q: { type: 'noul', instructions: 'Is a website down?' } })
  // The title and preview only (design-v2 "Safety"): no place, no sender, never the playbook.
  assert.deepEqual(jev.calls[0].items, [{ id: '0', text: 'site down\nexample.com returns 502' }])
  assert.deepEqual(jev.calls[0].options, { label: 'autopilot' })
  assert.deepEqual([logOf(t)[0].step, logOf(t)[0].score, logOf(t)[0].tabId], ['jev', 0.91, 'tab-1'])
  // Cached in appStorage under a `jv:` key per question and item, with the rev.
  const keys = (await t.ctx.appStorage.keys()).filter((k) => k.startsWith('jv:'))
  assert.equal(keys.length, 1)
  assert.equal((await t.ctx.appStorage.get(keys[0])).rev, 'SUP-1-r1')
  jev.answer = 0.2
  await t.push('bronos.jira', [item('SUP-2', { title: 'down?' }), ...jira.items])
  assert.equal(t.ctx.opened.length, 1)
  assert.deepEqual([logOf(t)[0].step, logOf(t)[0].score, logOf(t)[0].skip], ['jev', 0.2, 'jev 0.20 is below 0.7'])
  jev.answer = new Error('jev: monthly cap reached')
  await t.push('bronos.jira', [item('SUP-3', { title: 'down!' }), ...jira.items])
  assert.match(logOf(t)[0].skip, /^jev failed: jev: monthly cap reached; asked again in 10 min, no lower rule fires meanwhile$/)
  t.ctx.jev = null
  await t.push('bronos.jira', [item('SUP-4', { title: 'down!!' }), ...jira.items])
  assert.equal(t.ctx.opened.length, 1)
  assert.match(logOf(t)[0].skip, /^jev unavailable: no enabled plugin provides the jev service/)
  t.done()
})

test('first rule wins: one tab per item; the rules below that hold too are logged as also matched', async () => {
  const jira = fakeFeed(JIRA, [])
  const t = await setup({ on: true, feeds: { 'bronos.jira': jira }, rules: [rule('first'), rule('second'), rule('other', { when: [{ field: 'title', op: 'contains', value: 'nope' }] })] })
  await t.push('bronos.jira', [item('SUP-1', { title: 'site down' })])
  assert.equal(t.ctx.opened.length, 1)
  assert.deepEqual([logOf(t)[0].rule, logOf(t)[0].also], ['project:first', ['project:second']])
  // The item's rule hit its limit: the item is not handed to a lower rule.
  const capped = await setup({ on: true, feeds: { 'bronos.jira': fakeFeed(JIRA, []) }, rules: [rule('first', { limits: { perDay: 1, cooldownMinutes: 0 } }), rule('second')] })
  await capped.push('bronos.jira', [item('A', { title: 'down a' })])
  await capped.push('bronos.jira', [item('B', { title: 'down b' }), item('A', { title: 'down a' })])
  assert.equal(capped.ctx.opened.length, 1)
  assert.deepEqual([logOf(capped)[0].rule, logOf(capped)[0].step, logOf(capped)[0].also], ['project:first', 'limit', ['project:second']])
  capped.done()
  t.done()
})

test('a pending Jev answer holds a lower rule until it comes; yes takes the item, no hands it on', async () => {
  const jev = fakeJev(0.9)
  const jira = fakeFeed(JIRA, [])
  const rules = [rule('asked', { jev: { question: 'Is it real?', min: 0.5 }, limits: { cooldownMinutes: 0 } }), rule('plain', { limits: { cooldownMinutes: 0 } })]
  const t = await setup({ on: true, jev, feeds: { 'bronos.jira': jira }, rules })
  const release = jev.hold()
  await t.push('bronos.jira', [item('SUP-1', { title: 'site down' })])
  assert.equal(jev.calls.length, 1, 'asked')
  assert.equal(t.ctx.opened.length, 0, 'the plain rule below does not fire while the answer is pending')
  await t.clock.advance(30000)
  assert.equal(t.ctx.opened.length, 0)
  release()
  await settle()
  await t.ap.idle()
  await settle()
  assert.equal(t.ctx.opened.length, 1)
  assert.deepEqual([logOf(t)[0].rule, logOf(t)[0].score, logOf(t)[0].also], ['project:asked', 0.9, ['project:plain']])
  // A no: the next rule decides, once the answer is in.
  jev.answer = 0.1
  await t.push('bronos.jira', [item('SUP-2', { title: 'site down again' }), ...jira.items])
  assert.equal(t.ctx.opened.length, 2)
  assert.equal(logOf(t)[0].rule, 'project:plain')
  assert.deepEqual([logOf(t)[1].rule, logOf(t)[1].itemId], ['project:asked', 'SUP-1'], 'the no is not logged: a lower rule decided')
  t.done()
})

test('Jev unavailable retries after 10 minutes and never falls through to a lower rule', async () => {
  const jev = fakeJev(new Error('jev: monthly cap reached'))
  const jira = fakeFeed(JIRA, [])
  const rules = [rule('asked', { jev: { question: 'Is it real?', min: 0.5 }, limits: { cooldownMinutes: 0 } }), rule('plain', { limits: { cooldownMinutes: 0 } })]
  const t = await setup({ on: true, jev, feeds: { 'bronos.jira': jira }, rules })
  await t.push('bronos.jira', [item('SUP-1', { title: 'site down' })])
  assert.equal(t.ctx.opened.length, 0, 'the plain rule does not fire')
  assert.deepEqual([logOf(t)[0].rule, logOf(t)[0].step], ['project:asked', 'jev'])
  assert.match(logOf(t)[0].skip, /asked again in 10 min/)
  jev.answer = 0.8
  await t.clock.advance(9 * MIN)
  await t.ap.idle()
  assert.equal(jev.calls.length, 1, 'not asked again before 10 minutes')
  await t.clock.advance(MIN)
  await settle()
  await t.ap.idle()
  await t.clock.advance(0)
  await settle()
  await t.ap.idle()
  await settle()
  assert.equal(jev.calls.length, 2)
  assert.equal(t.ctx.opened.length, 1)
  assert.equal(logOf(t)[0].rule, 'project:asked')
  // An item that left its feed while it waited is dropped, never asked again.
  jev.answer = new Error('down again')
  await t.push('bronos.jira', [item('SUP-9', { title: 'down' }), ...jira.items])
  await t.push('bronos.jira', jira.items.filter((x) => x.id !== 'SUP-9'))
  jev.answer = 0.8
  await t.clock.advance(10 * MIN)
  await settle()
  await t.ap.idle()
  await t.clock.advance(0)
  await settle()
  assert.equal(jev.calls.length, 3, 'SUP-9 is gone: no fourth request')
  assert.equal(t.ctx.opened.length, 1)
  t.done()
})

test('two levels: a project rule beats a global one; each rule runs its own level\'s playbook and is named by level', async () => {
  const gdir = tempFolder([rule('down'), rule('lead', { sources: ['bronos.jira'], when: [{ field: 'title', op: 'contains', value: 'lead' }] })], { check: '# Global check\nThe global way.' })
  const jira = fakeFeed(JIRA, [])
  const t = await setup({ on: true, globalDir: gdir, feeds: { 'bronos.jira': jira } })
  try {
    assert.deepEqual(t.ctx.lastState().rules.map((r) => r.ref), ['project:down', 'global:down', 'global:lead'])
    await t.push('bronos.jira', [item('SUP-1', { title: 'site down' })])
    assert.equal(t.ctx.opened.length, 1)
    assert.deepEqual([logOf(t)[0].rule, logOf(t)[0].also], ['project:down', ['global:down']], 'project rules are checked first')
    assert.ok(t.ctx.opened[0].prompt.endsWith('# Check the site\nOpen the status page and report.\n'), "the project rule's own playbook")
    await t.push('bronos.jira', [item('SUP-2', { title: 'new lead' }), ...jira.items])
    assert.equal(t.ctx.opened.length, 2)
    const o = t.ctx.opened[1]
    assert.match(o.prompt, /^You were started by Autopilot for the rule "global:lead"/)
    assert.ok(o.prompt.endsWith('# Global check\nThe global way.\n'), 'a global rule reads the global playbooks/, never the project\'s')
    assert.equal(logOf(t)[0].rule, 'global:lead')
    // The project folder going away leaves the global rules running.
    t.ctx.setSettings({ projectFolder: '' }, { globalFolder: gdir })
    await t.ap.tick()
    assert.deepEqual(t.ctx.lastState().rules.map((r) => r.ref), ['global:down', 'global:lead'])
  } finally {
    t.done()
    removeFolder(gdir)
  }
})

test('also matched makes no Jev request; a cached yes counts', async () => {
  const jev = fakeJev(0.9)
  const jira = fakeFeed(JIRA, [])
  const rules = [rule('plain', { limits: { cooldownMinutes: 0 } }), rule('asked', { jev: { question: 'Is it real?', min: 0.5 } })]
  const t = await setup({ on: true, jev, feeds: { 'bronos.jira': jira }, rules })
  await t.push('bronos.jira', [item('SUP-1', { title: 'site down' })])
  assert.equal(t.ctx.opened.length, 1)
  assert.equal(jev.calls.length, 0, 'the Jev rule below is not asked for the log')
  assert.equal(logOf(t)[0].also, undefined)
  // A cached yes for that item and rev (another window, or the dry run, asked) does count.
  const { cacheKey } = require('../dist/lib/jev')
  await t.ctx.appStorage.set(cacheKey('Is it real?', 'bronos.jira', 'SUP-2'), { rev: 'SUP-2-r1', score: 0.8, at: NOW, seen: NOW })
  await t.ap.tick()
  await t.clock.advance(10 * MIN)
  await t.ap.tick()
  await t.push('bronos.jira', [item('SUP-2', { title: 'down 2' }), ...jira.items])
  assert.deepEqual(logOf(t)[0].also, ['project:asked'])
  assert.equal(jev.calls.length, 0)
  t.done()
})

test('a refused open is a logged skip and does not count as fired', async () => {
  const jira = fakeFeed(JIRA, [])
  const t = await setup({ on: true, feeds: { 'bronos.jira': jira }, rules: [rule('down', { onChange: true, limits: { cooldownMinutes: 0 } })] })
  t.ctx.openError = 'at most 5 sessions.open a minute'
  await t.push('bronos.jira', [item('SUP-1', { title: 'down', rev: 'a' })])
  assert.equal(t.ctx.opened.length, 0)
  assert.deepEqual([logOf(t)[0].step, logOf(t)[0].skip], ['open', 'open refused: at most 5 sessions.open a minute'])
  assert.equal(t.ctx.notes.length, 0)
  t.ctx.openError = null
  await t.push('bronos.jira', [item('SUP-1', { title: 'down', rev: 'b' })])
  assert.equal(t.ctx.opened.length, 1)
  t.done()
})

test('the folder is read fresh on each check: broken, then fixed, with no restart', async () => {
  const dir = tempFolder('[ not json', PLAYBOOKS)
  const jira = fakeFeed(JIRA, [])
  const t = await setup({ on: true, dir, feeds: { 'bronos.jira': jira } })
  await t.ctx.sendPanel({ type: 'hello' })
  assert.match(t.ctx.lastState().problems[0], /not valid JSON/)
  assert.equal(t.ctx.badges.at(-1), 'dot')
  await t.push('bronos.jira', [item('SUP-1', { title: 'down' })])
  assert.equal(t.ctx.opened.length, 0)
  fs.writeFileSync(path.join(dir, 'autopilot-rules.json'), JSON.stringify([rule('down')]))
  await t.push('bronos.jira', [item('SUP-2', { title: 'down' }), ...jira.items])
  assert.equal(t.ctx.opened.length, 1)
  assert.deepEqual(t.ctx.lastState().problems, [])
  // A folder that is gone: a problem, never a crash.
  t.ctx.setSettings({ projectFolder: path.join(dir, 'nope') })
  await settle()
  assert.match(t.ctx.lastState().problems[0], /not found: create it/)
  t.done()
  removeFolder(dir)
})

test('the dry run: decided as live (first rule wins), nothing opened, Jev only when asked', async () => {
  const jev = fakeJev(0.4)
  const jira = fakeFeed(JIRA, [item('SUP-1', { title: 'site down', where: 'Support' }), item('SUP-2', { title: 'fine' })])
  const rules = [rule('asked', { when: [{ field: 'place.name', op: 'contains', value: 'support' }], jev: { question: 'q?', min: 0.5 } }), rule('down'), rule('off', { enabled: false })]
  const t = await setup({ jev, feeds: { 'bronos.jira': jira }, rules })
  const d = await t.ap.dryRun(null, false)
  assert.equal(t.ctx.opened.length, 0)
  assert.equal(jev.calls.length, 0)
  assert.deepEqual(d.results.map((r) => [r.rule, r.itemId, r.fire]), [['project:asked', 'SUP-1', null], ['project:down', 'SUP-1', null], ['project:off', 'SUP-1', false]])
  assert.match(d.results[0].verdict, /Jev step was not asked .*no lower rule fires until it answers/)
  assert.deepEqual(d.results[1].why, ['any source', 'title contains down'])
  assert.equal(d.results[1].verdict, 'waits for the Jev answer of project:asked, which comes first')
  assert.equal(d.results[2].verdict, 'the rule is off')
  assert.equal(d.on, false)
  // With --jev: asked through lib/jev.js (one grid), the no hands the item to the next rule.
  const j = await drive(t.clock, t.ap.dryRun(null, true))
  assert.equal(jev.calls.length, 1)
  assert.deepEqual(j.results.map((r) => [r.rule, r.fire, r.verdict]), [['project:asked', false, 'jev 0.40 is below 0.5'], ['project:down', true, 'it would open a session'], ['project:off', false, 'the rule is off']])
  // Cached now: a second run asks nothing.
  await t.ap.dryRun(null, true)
  assert.equal(jev.calls.length, 1)
  // No provider with --jev: unavailable, and the rule below is held, not handed the item.
  t.ctx.jev = null
  const fresh = await setup({ feeds: { 'bronos.jira': fakeFeed(JIRA, [item('SUP-1', { title: 'site down', where: 'Support' })]) }, rules })
  const u = await fresh.ap.dryRun(null, true)
  assert.deepEqual(u.results.slice(0, 2).map((r) => [r.rule, r.fire]), [['project:asked', false], ['project:down', false]])
  assert.match(u.results[0].verdict, /^jev unavailable: no enabled plugin/)
  assert.equal(u.results[1].verdict, 'project:asked comes first and its Jev is unavailable')
  assert.match((await t.ap.dryRun('nope', false)).error, /No rule "nope"/)
  fresh.done()
  t.done()
})

test('the panel: state with the switch, rules and warnings, log; toggle and dry run from the page; header', async () => {
  const mail = fakeFeed(MAIL, [item('th1', { title: 'site down' })])
  const rules = [rule('anyone'), rule('mail', { sources: ['bronos.gmail'], when: [{ field: 'title', op: 'contains', value: 'x' }] }), rule('jira', { sources: ['bronos.jira'], when: [{ field: 'title', op: 'contains', value: 'x' }] })]
  const t = await setup({ feeds: { 'bronos.gmail': mail }, rules })
  await t.ctx.sendPanel({ type: 'hello' })
  let s = t.ctx.lastState()
  assert.equal(s.on, false)
  assert.deepEqual(s.levels.map((l) => [l.level, l.folderPath]), [['project', t.dir], ['global', null]])
  assert.deepEqual(s.rules.map((r) => r.ref), ['project:anyone', 'project:mail', 'project:jira'])
  assert.match(s.rules[0].warnings[0], /^outsiders can trigger this rule: its sources are any source/)
  assert.match(s.rules[1].warnings[0], /bronos.gmail is mail/)
  assert.deepEqual(s.rules[2].warnings, [])
  assert.equal(t.ctx.headers.at(-1).meta, 'off · 3 rules')
  assert.deepEqual(t.ctx.headers.at(-1).actions.map((a) => a.id), ['refresh'])
  await t.ctx.sendPanel({ type: 'toggle', on: true })
  s = t.ctx.lastState()
  assert.equal(s.on, true)
  assert.equal(t.ctx.headers.at(-1).meta, 'on · 3 rules')
  assert.match(s.log[0].note, /switched on/)
  await t.ctx.sendPanel({ type: 'dryRun' })
  assert.deepEqual(t.ctx.lastState().dry.results.map((r) => r.rule), ['project:anyone'])
  await t.ctx.sendPanel({ type: 'toggle', on: 'yes' })
  assert.equal(t.ctx.lastState().on, true, 'a non-boolean is ignored')
  t.done()
})

test('an app before 0.9.7: a fatal line in the panel, nothing else', async () => {
  const t = await setup({ old: true })
  await t.ctx.sendPanel({ type: 'hello' })
  assert.match(t.ctx.lastState().fatal, /needs cc-cockpit 0.9.7/)
  t.done()
})

test('the 60 s pass (ctx.schedule) re-reads a source whose snapshot failed, as a baseline; the panel refresh asks every source', async () => {
  const jira = fakeFeed(JIRA, [item('SUP-1', { title: 'down' })])
  jira.throwOn = 'snapshot'
  const t = await setup({ on: true, feeds: { 'bronos.jira': jira } })
  assert.equal(t.ctx.schedules[0].seconds, 60)
  assert.match(t.ap.status().sources[0].error, /feed broke/)
  jira.throwOn = null
  await t.ctx.schedules[0].fn()
  assert.equal(t.ctx.opened.length, 0, 'the first good read is the baseline, even though it holds a down item')
  assert.equal(t.ap.status().sources[0].error, undefined)
  assert.equal(t.ap.status().sources[0].items, 1)
  // A loaded source is not asked again by the 60 s pass (it pushes its changes) ...
  const asked = jira.calls.filter((c) => c[0] === 'snapshot').length
  jira.items = [...jira.items, item('SUP-2', { title: 'also down' })]
  await t.ctx.schedules[0].fn()
  assert.equal(jira.calls.filter((c) => c[0] === 'snapshot').length, asked)
  assert.equal(t.ctx.opened.length, 0)
  // ... the panel's refresh is, and what it finds that is new fires like any later sync.
  await t.ap.tick(true)
  assert.equal(t.ctx.opened.length, 1)
  assert.match(t.ctx.opened[0].prompt, /id: SUP-2/)
  t.done()
})

test('time moves: the fired record still blocks the item a day later; opens older than a day are pruned', async () => {
  const jira = fakeFeed(JIRA, [])
  const t = await setup({ on: true, feeds: { 'bronos.jira': jira } })
  await t.push('bronos.jira', [item('SUP-1', { title: 'down', rev: 'a' })])
  await t.clock.advance(25 * HOUR)
  // The tab closed, so it is the fired record (not the run) that blocks the item.
  t.ctx.closeTab('tab-1')
  await settle()
  await t.ap.idle()
  await t.push('bronos.jira', [item('SUP-1', { title: 'down', rev: 'b' })])
  assert.equal(t.ctx.opened.length, 1)
  await t.ap.tick()
  assert.equal(t.ap.state._sizes().opens, 0)
  assert.ok(t.ap.state.fired('project:down', 'bronos.jira', 'SUP-1'))
  t.done()
})

test('the header counts as the Rules tab does: "n of total rules on" when some are off or invalid, "n rules" when all are on', async () => {
  const t = await setup({ rules: [rule('a'), rule('b', { enabled: false }), rule('c', { enabled: false }), 42] })
  await t.ctx.sendPanel({ type: 'hello' })
  const lv = t.ctx.lastState().levels.find((l) => l.level === 'project')
  assert.equal(lv.entries.length, 4, 'the tab counts every entry')
  assert.match(t.ctx.headers.at(-1).meta, /^off · 1 of 4 rules on · 1 problem$/)
  t.done()
  const none = await setup({ rules: [] })
  await none.ctx.sendPanel({ type: 'hello' })
  assert.equal(none.ctx.headers.at(-1).meta, 'off · 0 rules')
  none.done()
})
