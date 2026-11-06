'use strict'
// One window per item (lib/claims.js and the host over it, design-v2 "One window per item"): the claim
// won and lost, released only by its owner, stale claims (clock AND awake passes), the sweep, the
// re-adoption after a restart; then two hosts sharing one app-wide store: the loser neither opens nor
// queues, updates go only from the owner, and each release point.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const C = require('../dist/lib/claims')
const RUNS = require('../dist/lib/runs')
const { createAutopilot } = require('../dist/host')
const { fakeCtx, fakeFeed, fakeClock, fakeStorage, fakeAppStorage, item, settle, tempFolder, removeFolder, rule, NOW, MIN, HOUR, JIRA } = require('./fakes')

const SRC = 'bronos.jira'
const run = (itemId, runId, o = {}) => ({ source: SRC, itemId, runId, rule: 'global:down', ...o })

/** Two windows' claims over one store, each with its own clock (`at`). */
function pair() {
  const store = fakeAppStorage()
  const clock = { t: NOW }
  const now = () => clock.t
  return { store, clock, a: C.createClaims({ store, project: '/work/a', now }), b: C.createClaims({ store, project: '/work/b', now }) }
}
/** `n` 60 s passes of `w` (lib/claims.js counts a pass at most every 30 s). */
async function passes(p, w, n) {
  let out
  for (let i = 0; i < n; i++) {
    p.clock.t += MIN
    out = await w.tick()
  }
  return out
}

test('keys: a hash of the item (no item text, far under 200 characters), at most three per claim', async () => {
  const p = pair()
  const id = `SUP-1 ${'é'.repeat(300)} ../../etc`
  assert.deepEqual(await p.a.claim(run(id, 'r000000000001')), { ok: true })
  const keys = [...p.store.map.keys()]
  const h = C.hashOf(SRC, id)
  assert.match(h, /^[0-9a-f]{32}$/)
  assert.deepEqual(keys.sort(), [`cl:${h}`, `co:${h}`])
  assert.ok(keys.every((k) => k.length < 200 && !k.includes('SUP')))
  assert.equal(C.hashOf(SRC, 'a'), C.hashOf(SRC, 'a'))
  assert.notEqual(C.hashOf('x.y', 'a'), C.hashOf('x.yz', 'a'))
  assert.notEqual(C.hashOf('a', 'b\u0000c'), C.hashOf('a\u0000b', 'c'), 'the separator is part of the hash')
  const o = p.store.map.get(`co:${h}`)
  assert.deepEqual(Object.keys(o), ['source', 'itemId', 'project', 'runId', 'rule', 'at', 'seen'])
  assert.deepEqual([o.project, o.runId, o.rule, o.at, o.seen], ['/work/a', 'r000000000001', 'global:down', NOW, NOW])
  await assert.rejects(p.a.claim(run('x', 'r 1')), /bad run/)
  await assert.rejects(p.a.claim(run('x', 'x'.repeat(65))), /bad run/)
})

test('won and lost: one owner per item, also when two windows claim at the same moment', async () => {
  const p = pair()
  assert.deepEqual(await p.a.claim(run('A', 'ra')), { ok: true })
  const lost = await p.b.claim(run('A', 'rb'))
  assert.equal(lost.ok, false)
  assert.deepEqual([lost.owner.project, lost.owner.runId], ['/work/a', 'ra'])
  assert.equal(p.a.owns(SRC, 'A'), true)
  assert.equal(p.b.owns(SRC, 'A'), false)
  // Again for the same run: still ours, nothing new written.
  const before = p.store.calls
  assert.deepEqual(await p.a.claim(run('A', 'ra')), { ok: true })
  assert.equal(p.store.calls - before, 1, 'one read')
  // At the same moment: main applies one increment at a time, so exactly one wins.
  const both = await Promise.all([p.a.claim(run('B', 'ra2')), p.b.claim(run('B', 'rb2'))])
  assert.deepEqual(both.map((r) => r.ok).sort(), [false, true])
  assert.equal(p.store.map.get(`cl:${C.hashOf(SRC, 'B')}`), 2)
})

test('released: only by the owner; a claim another window holds is never touched', async () => {
  const p = pair()
  await p.a.claim(run('A', 'ra'))
  const snapshot = new Map(p.store.map)
  assert.equal(await p.b.release(SRC, 'A'), false, 'not ours: nothing deleted')
  assert.deepEqual(p.store.map, snapshot)
  assert.equal(await p.a.release(SRC, 'A'), true)
  assert.equal(p.store.map.size, 0, 'co, then cl: both gone')
  assert.equal(p.a.owns(SRC, 'A'), false)
  assert.equal(await p.a.release(SRC, 'A'), false, 'twice: nothing to do')
  assert.deepEqual(await p.b.claim(run('A', 'rb')), { ok: true }, 'free again')
  // A window that lost its claim to a takeover does not delete the new owner's keys on its release.
  await p.a.claim(run('C', 'ra3'))
  const h = C.hashOf(SRC, 'C')
  p.store.map.set(`co:${h}`, { ...p.store.map.get(`co:${h}`), project: '/work/b', runId: 'rb3' })
  assert.equal(await p.a.release(SRC, 'C'), false)
  assert.equal(p.store.map.get(`co:${h}`).runId, 'rb3')
  assert.equal(p.a.owns(SRC, 'C'), false)
})

test('stale: freed only after 3 h by the clock AND 30 passes of watching; a live owner refreshes every 10 min', async () => {
  const p = pair()
  await p.a.claim(run('A', 'ra'))
  // A sleep: the clock jumps 8 h. The owner has not had its pass yet, so the record looks old, but
  // the other window has watched it for no awake time at all: lost.
  p.clock.t += 8 * HOUR
  assert.equal((await p.b.claim(run('A', 'rb'))).ok, false)
  // The owner wakes and refreshes: `seen` moves, the watch starts over.
  await p.a.tick()
  const h = C.hashOf(SRC, 'A')
  assert.equal(p.store.map.get(`co:${h}`).seen, p.clock.t)
  // Owner A is gone now (a crash): no more refreshes. b starts watching the record at its 5th pass
  // (so its sweeps, every 10 passes, do not free it first); 29 passes of watching are not enough
  // even 3 h on, the 30th is.
  p.clock.t += 3 * HOUR
  await passes(p, p.b, 5)
  assert.equal((await p.b.claim(run('A', 'rb'))).ok, false)
  await passes(p, p.b, 29)
  assert.equal((await p.b.claim(run('A', 'rb'))).ok, false)
  await passes(p, p.b, 1)
  const took = await p.b.claim(run('A', 'rb'))
  assert.equal(took.ok, true)
  assert.equal(took.took.runId, 'ra')
  assert.equal(p.store.map.get(`co:${h}`).runId, 'rb')
  assert.equal(p.store.map.get(`ct:${h}:ra`), 1, 'the take lock let one window through')
  // A pass burst (the refresh button) does not count: 30 passes within 30 s are one.
  const q = pair()
  await q.a.claim(run('A', 'ra'))
  q.clock.t += 4 * HOUR
  await q.b.claim(run('A', 'rb'))
  for (let i = 0; i < 40; i++) await q.b.tick()
  assert.equal((await q.b.claim(run('A', 'rb'))).ok, false)
  // The clock alone is not enough either: a record watched for 30 passes but refreshed 2 h ago stays.
  const r = pair()
  await r.a.claim(run('A', 'ra'))
  r.clock.t += 2 * HOUR
  await r.b.claim(run('A', 'rb'))
  await passes(r, r.b, 30)
  assert.equal((await r.b.claim(run('A', 'rb'))).ok, false, '2 h 30 min since the refresh: under 3 h')
})

test('lost: the old owner sees the takeover on its next refresh and stops; its release leaves the keys alone', async () => {
  const p = pair()
  await p.a.claim(run('A', 'ra'))
  p.clock.t += 4 * HOUR
  await passes(p, p.b, 5)
  await p.b.claim(run('A', 'rb'))
  await passes(p, p.b, 30)
  assert.equal((await p.b.claim(run('A', 'rb'))).took.runId, 'ra')
  const out = await p.a.tick()
  assert.deepEqual(out.lost.map((l) => [l.itemId, l.runId, l.owner.project]), [['A', 'ra', '/work/b']])
  assert.equal(p.a.owns(SRC, 'A'), false)
  assert.equal(await p.a.release(SRC, 'A'), false)
  assert.equal(p.b.owns(SRC, 'A'), true)
  // b releases: its take lock goes too.
  assert.equal(await p.b.release(SRC, 'A'), true)
  assert.equal(p.store.map.size, 0)
})

test('the sweep: stale claims freed, own leftovers at once, a counter with no owner and an old take lock after two sweeps', async () => {
  const p = pair()
  const h = (id) => C.hashOf(SRC, id)
  await p.a.claim(run('stale', 'ra'))
  await p.a.claim(run('live', 'ra2'))
  // A crash between the increment and the owner write: a counter with no owner.
  p.store.map.set(`cl:${h('orphan')}`, 1)
  // A take lock whose owner run is gone.
  p.store.map.set(`ct:${h('gone')}:rx`, 1)
  // Another app's keys (the Jev cache) are never touched.
  p.store.map.set('jv:abc:def', { score: 1 })
  // b's own leftover from before a restart: same project, a run b does not hold.
  p.store.map.set(`co:${h('mine-old')}`, { source: SRC, itemId: 'mine-old', project: '/work/b', runId: 'rold', rule: 'project:x', at: NOW, seen: NOW })
  p.store.map.set(`cl:${h('mine-old')}`, 1)
  p.clock.t += 4 * HOUR
  // a keeps "live" fresh; "stale" is a's too, so a refreshes both: make "stale" another window's.
  p.store.map.set(`co:${h('stale')}`, { ...p.store.map.get(`co:${h('stale')}`), project: '/work/c', runId: 'rc' })
  let freed = []
  let cleaned = 0
  for (let i = 0; i < 40; i++) {
    p.clock.t += MIN
    for (const o of [await p.a.tick(), await p.b.tick()]) {
      freed.push(...(o.freed || []).map((f) => f.itemId))
      cleaned += o.cleaned || 0
    }
  }
  assert.ok(freed.includes('mine-old'), 'own leftover')
  assert.ok(freed.includes('stale'), 'another window\'s stale claim, freed by one of the two')
  assert.equal(freed.filter((x) => x === 'stale').length, 1, 'once: the take lock')
  assert.ok(!freed.includes('live'), 'a refreshed claim stays')
  assert.equal(p.store.map.has(`co:${h('live')}`), true)
  assert.equal(p.store.map.has(`co:${h('stale')}`), false)
  assert.equal(p.store.map.has(`cl:${h('orphan')}`), false)
  assert.equal(p.store.map.has(`ct:${h('gone')}:rx`), false)
  assert.equal(p.store.map.has('jv:abc:def'), true)
  assert.ok(cleaned >= 2)
  // Bounded: what is left is a's live claim (two keys), the Jev key, and the newest take locks only.
  const left = [...p.store.map.keys()].filter((k) => !k.startsWith('ct:'))
  assert.deepEqual(left.sort(), [`cl:${h('live')}`, `co:${h('live')}`, 'jv:abc:def'].sort())
})

test('adopt: a restart keeps its own claim by run id; a counter left by a cut-short release is no reason to give the tab up', async () => {
  const p = pair()
  await p.a.claim(run('A', 'ra'))
  const before = new Map(p.store.map)
  // A new host of the same project (after a restart): the record's run id.
  const a2 = C.createClaims({ store: p.store, project: '/work/a', now: () => p.clock.t })
  assert.deepEqual(await a2.claim(run('A', 'ra'), { adopt: true }), { ok: true })
  assert.deepEqual(p.store.map, before, 'kept as it was')
  assert.equal(a2.owns(SRC, 'A'), true)
  // A quit cut a release short: the owner went, the counter stayed.
  p.store.map.delete(`co:${C.hashOf(SRC, 'B')}`)
  p.store.map.set(`cl:${C.hashOf(SRC, 'B')}`, 1)
  assert.equal((await p.b.claim(run('B', 'rb'))).ok, false, 'a fresh claim loses to the counter')
  assert.deepEqual(await a2.claim(run('B', 'ra2'), { adopt: true }), { ok: true }, 'the tab\'s own record adopts it')
  // Another window's live claim is never taken by an adoption.
  await p.b.claim(run('C', 'rb3'))
  assert.equal((await a2.claim(run('C', 'ra3'), { adopt: true })).ok, false)
})

// ---- two hosts over one app-wide store ----

const PLAYBOOKS = { check: '# Check the site\nOpen the status page and report.' }
const down = (rev, o = {}) => item('SUP-1', { title: 'site down', rev, ...o })

/**
 * Two project windows: their own folders, storage and tabs; one app-wide store and one global rules
 * folder. `o.rules`: the global rules (default one `down` rule).
 */
async function windows(o = {}) {
  const gdir = tempFolder(o.rules || [rule('down', { limits: { cooldownMinutes: 0, perDay: 100 } })], PLAYBOOKS)
  const appStorage = o.appStorage || fakeAppStorage()
  const clock = fakeClock()
  const make = async (projectDir, storage = fakeStorage(), extra = {}) => {
    await storage.set('enabled', true)
    const ctx = fakeCtx({ projectDir, globalFolder: gdir, storage, appStorage, settings: o.settings })
    for (const s of extra.sessions || []) ctx.sessionList.push(s)
    const feed = fakeFeed(JIRA, extra.items || [])
    ctx.addProvider(SRC, feed)
    const ap = createAutopilot(ctx, { now: clock.now, timers: clock.timers, debounceMs: 1000, home: '/home/ann' })
    await ap.first
    const w = { ctx, ap, feed, storage }
    w.idle = async () => {
      await settle()
      await ap.idle()
      await settle()
    }
    w.push = async (items) => {
      feed.items = items
      ctx.emitFeed(SRC, 'sync', { items, state: 'ok', asOf: NOW })
      await settle()
      await clock.advance(1000)
      await w.idle()
    }
    w.set = async (tabId, patch) => {
      ctx.setSession(tabId, patch)
      await w.idle()
    }
    w.close = async (tabId) => {
      ctx.closeTab(tabId)
      await w.idle()
    }
    w.log = () => ap.state.recent()
    return w
  }
  const a = await make('/work/a')
  const b = await make('/work/b')
  const env = { gdir, appStorage, clock, a, b, make }
  env.claimKeys = () => [...appStorage.map.keys()].filter((k) => /^c[lot]:/.test(k))
  env.both = async (items) => {
    // The same news reaches both windows; a first, as one of them always is.
    await a.push(items)
    await b.push(items)
  }
  env.done = async () => {
    await a.ap.dispose()
    await b.ap.dispose()
    removeFolder(gdir)
  }
  return env
}

test('two windows, one global rule: one tab; the loser logs "running in another window" and does not queue', async () => {
  const e = await windows({ settings: { maxRunning: 1 } })
  await e.both([down('a')])
  assert.equal(e.a.ctx.opened.length, 1)
  assert.equal(e.b.ctx.opened.length, 0)
  const l = e.b.log()[0]
  assert.equal(l.step, 'claim')
  assert.match(l.skip, /^running in another window \(\/work\/a, global:down, since \d{4}-\d\d-\d\d \d\d:\d\d UTC\): not opened here, not queued$/)
  assert.equal(e.b.ap.runs.queued().length, 0)
  assert.equal(e.a.ap.claims.owns(SRC, 'SUP-1'), true)
  // A newer rev changes nothing in b while a holds the item.
  await e.b.push([down('b')])
  assert.equal(e.b.ctx.opened.length, 0)
  await e.done()
})

test('released when the tab closes: the next rev opens in the other window', async () => {
  const e = await windows()
  await e.both([down('a')])
  assert.equal(e.claimKeys().length, 2)
  await e.a.close('tab-1')
  assert.equal(e.a.ap.claims.owns(SRC, 'SUP-1'), false)
  assert.deepEqual(e.claimKeys(), [], 'released')
  await e.b.push([down('b')])
  assert.equal(e.b.ctx.opened.length, 1)
  assert.equal(e.b.ap.claims.owns(SRC, 'SUP-1'), true)
  await e.done()
})

test('released when the tab ends, the rule is switched off, an open is refused, and at deactivate', async () => {
  const e = await windows()
  // Ended: the tab is still listed, the claim goes.
  await e.a.push([down('a')])
  assert.equal(e.a.ap.claims.owns(SRC, 'SUP-1'), true)
  await e.a.set('tab-1', { status: 'ended' })
  assert.equal(e.a.ap.claims.owns(SRC, 'SUP-1'), false)
  assert.deepEqual(e.claimKeys(), [])
  // Switched off in the rules file: a running tab's claim goes at the next pass.
  await e.b.push([item('SUP-2', { title: 'site down', rev: 'a' })])
  assert.equal(e.b.ap.claims.owns(SRC, 'SUP-2'), true)
  fs.writeFileSync(path.join(e.gdir, 'autopilot-rules.json'), JSON.stringify([rule('down', { enabled: false })]))
  await e.b.ap.tick()
  assert.equal(e.b.ap.claims.owns(SRC, 'SUP-2'), false)
  assert.deepEqual(e.claimKeys(), [])
  fs.writeFileSync(path.join(e.gdir, 'autopilot-rules.json'), JSON.stringify([rule('down', { limits: { cooldownMinutes: 0, perDay: 100 } })]))
  // Open refused (the app's own limit): no tab, no claim.
  e.a.ctx.openError = 'at most 5 sessions.open a minute'
  await e.a.push([item('SUP-3', { title: 'site down', rev: 'a' })])
  assert.match(e.a.log()[0].skip, /open refused/)
  assert.deepEqual(e.claimKeys(), [])
  e.a.ctx.openError = null
  // Deactivate: every claim of the window released (dispose resolves when done).
  await e.a.push([item('SUP-4', { title: 'site down', rev: 'a' })])
  assert.equal(e.claimKeys().length, 2)
  await e.a.ap.dispose()
  assert.deepEqual(e.claimKeys(), [])
  await e.done()
})

test('a queued item holds its claim and opens under it; switching off or the item leaving releases it', async () => {
  const e = await windows({ settings: { maxRunning: 1 } })
  await e.a.push([down('a')])
  await e.a.push([item('SUP-2', { title: 'site down', rev: 'a' }), down('a')])
  assert.deepEqual(e.a.ap.runs.queued().map((q) => q.itemId), ['SUP-2'])
  const runId = e.a.ap.runs.queuedOf(SRC, 'SUP-2').runId
  assert.equal(e.appStorage.map.get(`co:${C.hashOf(SRC, 'SUP-2')}`).runId, runId)
  // b sees SUP-2 too: a holds it (queued), so b neither opens nor queues it.
  await e.b.push([item('SUP-2', { title: 'site down', rev: 'a' })])
  assert.equal(e.b.ctx.opened.length, 0)
  assert.equal(e.b.ap.runs.queued().length, 0)
  // The slot frees (the first tab finished): SUP-2 opens in a, under the run id it was claimed with.
  await e.a.set('tab-1', { status: 'waiting' })
  assert.equal(e.a.ctx.opened.length, 2)
  assert.equal(e.a.ap.runs.runOf(SRC, 'SUP-2').record.runId, runId)
  // A new queued item, then switched off: the queue's claim goes, the tabs keep theirs.
  await e.a.set('tab-2', { status: 'working' })
  await e.a.push([item('SUP-3', { title: 'site down', rev: 'a' }), item('SUP-2', { title: 'site down', rev: 'a' }), down('a')])
  assert.deepEqual(e.a.ap.runs.queued().map((q) => q.itemId), ['SUP-3'])
  assert.equal(e.appStorage.map.has(`co:${C.hashOf(SRC, 'SUP-3')}`), true)
  await e.a.ap.setEnabled(false)
  await e.a.idle()
  assert.equal(e.appStorage.map.has(`co:${C.hashOf(SRC, 'SUP-3')}`), false)
  assert.equal(e.appStorage.map.has(`co:${C.hashOf(SRC, 'SUP-2')}`), true, 'a running tab keeps its claim')
  await e.done()
})

test('a restart re-adopts its claims by run id; a restored tab another window claimed meanwhile gets no update', async () => {
  const e = await windows({ rules: [rule('down', { onChange: true, limits: { cooldownMinutes: 0, perDay: 100 } })] })
  await e.a.push([down('a')])
  await e.a.set('tab-1', { sessionId: 'sess-1', status: 'waiting' })
  const keys = new Map(e.appStorage.map)
  // An app quit: main does not wait for deactivate, so nothing is released. A new host of project a
  // starts over the same storage, the tab restored under a new id with the same Claude session.
  const a2 = await e.make('/work/a', e.a.storage, { sessions: [{ tabId: 'tab-9', sessionId: 'sess-1', status: 'waiting', typed: false }], items: [down('a')] })
  assert.equal(a2.ap.claims.owns(SRC, 'SUP-1'), true)
  assert.deepEqual(new Map([...e.appStorage.map].filter(([k]) => /^c[lot]:/.test(k))), new Map([...keys].filter(([k]) => /^c[lot]:/.test(k))), 'the claim is kept as it was')
  // A third window (project c) whose record says it has the same item: it is a's, so c delivers nothing.
  const rec = { source: SRC, itemId: 'SUP-1', tabId: 'tab-5', sessionId: 'sess-5', rule: 'global:down', rev: 'a', openedAt: NOW, runId: 'r0000000000c5' }
  const cStore = fakeStorage()
  await cStore.set(RUNS.KEY, [rec])
  const c = await e.make('/work/c', cStore, { sessions: [{ tabId: 'tab-5', sessionId: 'sess-5', status: 'waiting', typed: false }], items: [down('a')] })
  assert.equal(c.ap.claims.owns(SRC, 'SUP-1'), false)
  assert.match(c.log().find((x) => x.step === 'claim').note, /tab tab-5: the item is claimed by another window \(\/work\/a\); nothing is delivered into this tab/)
  await c.push([down('b')])
  assert.equal(c.ctx.sent.length, 0)
  assert.match(c.log()[0].skip, /nothing sent \(this window does not hold the item's claim\)/)
  await c.ap.dispose()
  assert.equal(e.appStorage.map.get(`co:${C.hashOf(SRC, 'SUP-1')}`).project, '/work/a', 'c never released a claim it did not own')
  await a2.ap.dispose()
  await e.done()
})

test('fail closed: a store that does not answer opens nothing and says so', async () => {
  const e = await windows()
  e.appStorage.failing = true
  await e.a.push([down('a')])
  assert.equal(e.a.ctx.opened.length, 0)
  assert.match(e.a.log()[0].skip, /^the app-wide claim failed: appStorage is not answering; not opened$/)
  e.appStorage.failing = false
  await e.done()
})
