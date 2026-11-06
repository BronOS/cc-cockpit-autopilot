'use strict'
// The stored state: the switch (off by default), once per rev records, limits, the capped log, pruning.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createState, LOG_MAX, FIRED_MAX, GLOBAL_PER_HOUR } = require('../dist/lib/state')
const { fakeStorage, NOW, MIN, HOUR } = require('./fakes')

const R = (id, perDay = 10, cooldownMinutes = 30) => ({ id, limits: { perDay, cooldownMinutes } })

test('off by default; the switch is stored', async () => {
  const storage = fakeStorage()
  const s = createState(storage)
  await s.load()
  assert.equal(s.enabled(), false)
  await s.setEnabled(true)
  const again = createState(storage)
  await again.load()
  assert.equal(again.enabled(), true)
  // Junk in the store is not "on".
  await storage.set('enabled', 'yes')
  await again.load()
  assert.equal(again.enabled(), false)
})

test('fired records survive a reload; junk entries are dropped; the cap keeps the newest', async () => {
  const storage = fakeStorage()
  const s = createState(storage)
  await s.load()
  await s.markFired('r', 'bronos.jira', 'SUP-123', 'rev1', NOW)
  await storage.set('fired', [...(await storage.get('fired')), { rule: 1 }, null])
  const again = createState(storage)
  await again.load()
  assert.deepEqual(again.fired('r', 'bronos.jira', 'SUP-123'), { rule: 'r', source: 'bronos.jira', id: 'SUP-123', rev: 'rev1', at: NOW })
  assert.equal(again.fired('r', 'bronos.jira', 'SUP-124'), null)
  for (let i = 0; i < FIRED_MAX + 5; i++) await again.markFired('r', 'p.x', `i${i}`, '1', NOW + i)
  assert.equal(again._sizes().fired, FIRED_MAX)
  assert.equal(again.fired('r', 'p.x', 'i0'), null)
  assert.ok(again.fired('r', 'p.x', `i${FIRED_MAX + 4}`))
})

test('limits: the global cap, then perDay, then the cooldown', async () => {
  const s = createState(fakeStorage())
  await s.load()
  const a = R('a', 2, 30)
  assert.equal(s.limitReason(a, NOW), null)
  await s.recordOpen('a', NOW)
  assert.match(s.limitReason(a, NOW + 10 * MIN), /cooldown: the last session for this rule was 10 min ago/)
  assert.equal(s.limitReason(a, NOW + 31 * MIN), null)
  await s.recordOpen('a', NOW + 31 * MIN)
  assert.match(s.limitReason(a, NOW + 2 * HOUR), /2 sessions in 24 h for this rule \(perDay 2\)/)
  assert.equal(s.limitReason(a, NOW + 24 * HOUR + 32 * MIN), null, 'a rolling day')
  // Another rule is not limited by a's opens, until the hour holds 10 of all rules.
  const b = R('b', 100, 0)
  assert.equal(s.limitReason(b, NOW + 32 * MIN), null)
  for (let i = 0; i < GLOBAL_PER_HOUR - 2; i++) await s.recordOpen('b', NOW + 32 * MIN)
  assert.match(s.limitReason(b, NOW + 33 * MIN), /10 sessions in the last hour \(all rules\)/)
  assert.equal(s.limitReason(b, NOW + 33 * MIN + HOUR), null)
})

test('the log keeps the last 200, newest first', async () => {
  const s = createState(fakeStorage())
  await s.load()
  for (let i = 0; i < LOG_MAX + 10; i++) await s.append({ at: NOW + i, rule: 'r', step: 'rule', tabId: `t${i}` })
  assert.equal(s._sizes().log, LOG_MAX)
  assert.equal(s.recent(1)[0].tabId, `t${LOG_MAX + 9}`)
  assert.equal(s.recent().at(-1).tabId, 't10')
})

test('prune: fired records after 14 days, opens after a day', async () => {
  const s = createState(fakeStorage())
  await s.load()
  await s.markFired('r', 'p.x', 'old', '1', NOW)
  await s.markFired('r', 'p.x', 'new', '1', NOW + 10 * 24 * HOUR)
  await s.recordOpen('r', NOW)
  await s.prune(NOW + 15 * 24 * HOUR)
  assert.equal(s.fired('r', 'p.x', 'old'), null)
  assert.ok(s.fired('r', 'p.x', 'new'))
  assert.equal(s._sizes().opens, 0)
})
