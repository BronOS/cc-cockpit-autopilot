'use strict'
// lib/jev.js: the Jev answers behind a rule's question. Cache per question and rev in appStorage `jv:`
// keys, one batched grid per question, the 45 s call limit, unavailable as a 10-minute retry handed
// back through onAnswer, cached() never asking, the 14-day prune. A fake clock drives every timer.
const test = require('node:test')
const assert = require('node:assert/strict')
const J = require('../dist/lib/jev')
const { fakeJev, fakeAppStorage, fakeClock, item, settle, MIN } = require('./fakes')

const R = (id, question = 'Is a site down?', min = 0.5) => ({ id, jev: { question, min } })
const DAY = 24 * 60 * MIN

function setup(o = {}) {
  const clock = fakeClock()
  const store = o.store || fakeAppStorage()
  const provider = 'jev' in o ? o.jev : fakeJev(0.8)
  const services = {
    available: (n) => n === 'jev' && Boolean(services.provider),
    use: () => ({ grid: (...a) => services.provider.impl.grid(...structuredClone(a)) }),
    provider,
  }
  const answered = []
  const jev = J.createJev({ store, services, now: clock.now, timers: clock.timers, onAnswer: (refs) => answered.push(...refs) })
  return { clock, store, services, jev, answered, provider }
}

test('a miss is pending and queued; the items of one question go in one grid; the answer is cached by rev', async () => {
  const t = setup()
  const a = item('A-1', { title: 'site down', preview: 'since 9:00' })
  const b = item('B-1', { title: 'all fine' })
  assert.deepEqual(t.jev.answer(R('r'), 'bronos.jira', a), { pending: true })
  assert.deepEqual(t.jev.answer(R('r'), 'bronos.jira', b), { pending: true })
  assert.deepEqual(t.jev.answer(R('r'), 'bronos.jira', a), { pending: true }, 'asked once')
  assert.equal(t.jev.pending(), 2)
  await t.clock.advance(0)
  assert.equal(t.provider.calls.length, 1)
  assert.deepEqual(t.provider.calls[0].items.map((x) => x.text), ['site down\nsince 9:00', 'all fine'], 'title and preview only')
  assert.deepEqual(t.provider.calls[0].questions, { q: { type: 'noul', instructions: 'Is a site down?' } })
  assert.deepEqual(t.answered, [{ pluginId: 'bronos.jira', id: 'A-1' }, { pluginId: 'bronos.jira', id: 'B-1' }])
  assert.deepEqual(t.jev.answer(R('r'), 'bronos.jira', a), { score: 0.8 })
  assert.deepEqual(t.jev.cached(R('r'), 'bronos.jira', a), { score: 0.8 })
  const key = J.cacheKey('Is a site down?', 'bronos.jira', 'A-1')
  assert.match(key, /^jv:[0-9a-f]{16}:[0-9a-f]{32}$/)
  assert.equal((await t.store.get(key)).rev, 'A-1-r1')
  // A new rev asks again; the same rev with another `min` does not; another question does.
  assert.equal(t.jev.cached(R('r'), 'bronos.jira', { ...a, rev: 'A-1-r2' }), null)
  assert.deepEqual(t.jev.answer(R('r', 'Is a site down?', 0.9), 'bronos.jira', a), { score: 0.8 })
  assert.equal(t.jev.cached(R('r', 'Another?'), 'bronos.jira', a), null)
  // Another window's answer is read by load().
  const other = setup({ store: t.store })
  await other.jev.load()
  assert.deepEqual(other.jev.cached(R('r'), 'bronos.jira', a), { score: 0.8 })
  t.jev.dispose()
  other.jev.dispose()
})

test('unavailable: a failed call, no provider, a missing score; retried after 10 minutes, never cached', async () => {
  const t = setup()
  const a = item('A-1')
  t.provider.answer = new Error('monthly cap reached')
  t.jev.answer(R('r'), 'bronos.jira', a)
  await t.clock.advance(0)
  assert.equal(t.answered.length, 1, 'handed back at once, so the host logs the retry')
  assert.deepEqual(t.jev.answer(R('r'), 'bronos.jira', a), { unavailable: 'jev failed: monthly cap reached' })
  assert.deepEqual(await t.store.keys(), [])
  t.provider.answer = 0.6
  await t.clock.advance(10 * MIN - 1)
  assert.equal(t.answered.length, 1)
  await t.clock.advance(1)
  assert.equal(t.answered.length, 2, 'handed back after 10 minutes')
  assert.deepEqual(t.jev.answer(R('r'), 'bronos.jira', a), { pending: true }, 'asked anew')
  await t.clock.advance(0)
  assert.deepEqual(t.jev.answer(R('r'), 'bronos.jira', a), { score: 0.6 })
  // No provider: unavailable at once, handed back in 10 minutes.
  const n = setup({ jev: null })
  assert.match(n.jev.answer(R('r'), 'bronos.jira', a).unavailable, /no enabled plugin provides the jev service/)
  await n.clock.advance(10 * MIN)
  assert.deepEqual(n.answered, [{ pluginId: 'bronos.jira', id: 'A-1' }])
  // A hostile answer (no score) is unavailable too.
  const h = setup()
  h.provider.answer = () => null
  h.jev.answer(R('r'), 'bronos.jira', a)
  await h.clock.advance(0)
  assert.deepEqual(h.jev.answer(R('r'), 'bronos.jira', a), { unavailable: 'jev gave no score' })
  for (const x of [t, n, h]) x.jev.dispose()
})

test('a grid that never answers is unavailable after 45 s', async () => {
  const t = setup()
  t.provider.hold()
  t.jev.answer(R('r'), 'bronos.jira', item('A-1'))
  await t.clock.advance(0)
  assert.deepEqual(t.jev.answer(R('r'), 'bronos.jira', item('A-1')), { pending: true }, 'in flight')
  await t.clock.advance(J.CALL_TIMEOUT_MS)
  assert.match(t.jev.answer(R('r'), 'bronos.jira', item('A-1')).unavailable, /no answer in 45 s/)
  t.jev.dispose()
})

test('ask() awaits one answer; cached() never asks', async () => {
  const t = setup()
  assert.equal(t.jev.cached(R('r'), 'bronos.jira', item('A-1')), null)
  assert.equal(t.provider.calls.length, 0)
  const p = t.jev.ask(R('r'), 'bronos.jira', item('A-1'))
  await t.clock.advance(0)
  assert.deepEqual(await p, { score: 0.8 })
  t.jev.dispose()
})

test('prune drops answers not used for 14 days; a use bumps seen once a day', async () => {
  const t = setup()
  const a = item('A-1')
  const b = item('B-1')
  t.jev.answer(R('r'), 'bronos.jira', a)
  t.jev.answer(R('r'), 'bronos.jira', b)
  await t.clock.advance(0)
  await t.clock.advance(10 * DAY)
  t.jev.answer(R('r'), 'bronos.jira', a)
  await settle()
  await t.clock.advance(5 * DAY)
  await t.jev.prune()
  assert.deepEqual(t.jev.cached(R('r'), 'bronos.jira', a), { score: 0.8 }, 'used 5 days ago')
  assert.equal(t.jev.cached(R('r'), 'bronos.jira', b), null, 'unused for 15 days')
  assert.deepEqual(await t.store.keys(), [J.cacheKey('Is a site down?', 'bronos.jira', 'A-1')])
  t.jev.dispose()
})
