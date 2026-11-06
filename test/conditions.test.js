'use strict'
// Inbox's condition tests, copied (bronos.inbox test/rules.test.js "conditions"): `when` in an
// Autopilot rule is the same format, so the same cases must hold here. The source's kind comes from
// `kindOf`, as the host gets it from the provider's description.
const test = require('node:test')
const assert = require('node:assert/strict')
const C = require('../dist/lib/conditions')
const { NOW, HOUR, bare } = require('./fakes')


const KINDS = { 'bronos.chat': 'chat', 'bronos.gmail': 'mail', 'bronos.jira': 'issues', 'x.other': 'other' }
const kindOf = (pluginId) => KINDS[pluginId]
const opts = (o = {}) => ({ now: NOW, kindOf, ...o })

/** A stored item: a v2 FeedItem with `source` set, with no `from` and no `place` unless `extra` brings them. */
const it = (source, id, o = {}) => ({ ...bare(id, { ...o, extra: undefined }), ...(o.extra || {}), source })
/** Whether a single condition holds for an item. */
const check = (field, op, value, item) => {
  const c = C.conditionOf({ field, op, value })
  assert.ok(c, `${field} ${op} ${JSON.stringify(value)} is a valid condition`)
  return C.holds(c, item, kindOf(item.source) || 'other', NOW)
}


// --- conditions ------------------------------------------------------------------------------

test('conditionOf: the field table, value kinds, in lists, hostile input', () => {
  assert.deepEqual(C.conditionOf({ field: 'title', op: 'contains', value: '  login  ' }), { field: 'title', op: 'contains', value: 'login' })
  assert.deepEqual(C.conditionOf({ field: 'to', op: 'in', value: ['direct', 'cc', 'direct'] }), { field: 'to', op: 'in', value: ['direct', 'cc'] })
  assert.deepEqual(C.conditionOf({ field: 'time', op: 'newerThan', value: 60 }), { field: 'time', op: 'newerThan', value: 60 })
  for (const bad of [
    { field: 'title', op: 'matches', value: '.*' }, // no regex op
    { field: 'title', op: 'in', value: ['a'] }, // op not for this field
    { field: 'title', op: 'contains', value: '' },
    { field: 'title', op: 'contains', value: 'x'.repeat(201) },
    { field: 'title', op: 'contains', value: 3 },
    { field: 'to', op: 'is', value: 'everyone' },
    { field: 'sourceKind', op: 'is', value: 'calendar' },
    { field: 'mentionsMe', op: 'is', value: 'true' },
    { field: 'read', op: 'is', value: 0 },
    { field: 'time', op: 'olderThan', value: 0 },
    { field: 'time', op: 'olderThan', value: 525601 },
    { field: 'time', op: 'olderThan', value: 1.5 },
    { field: 'from.address', op: 'in', value: [] },
    { field: 'from.address', op: 'in', value: Array.from({ length: 51 }, (_, i) => `a${i}@example.com`) },
    { field: 'from.address', op: 'in', value: ['ok@example.com', 5] },
    { field: 'from.address', op: 'in', value: 'ok@example.com' },
    { field: '__proto__', op: 'is', value: 'x' },
    { field: 'constructor', op: 'is', value: 'x' },
    { field: 'labels', op: 'has' },
    null,
    'read is true',
    [],
  ]) {
    assert.equal(C.conditionOf(bad), null, JSON.stringify(bad))
  }
  assert.deepEqual(C.conditionOf({ field: 'read', op: 'is', value: null }), { field: 'read', op: 'is', value: null })
})

test('text ops: case-insensitive over NFKC, absent fields hold only for the negative ops', () => {
  const m = it('bronos.gmail', 't1', { title: 'Fix the LOGIN redirect', preview: 'See ＰＲＯＪ-12' })
  assert.equal(check('title', 'contains', 'login', m), true)
  assert.equal(check('title', 'contains', 'logout', m), false)
  assert.equal(check('title', 'notContains', 'logout', m), true)
  assert.equal(check('title', 'notContains', 'Login', m), false)
  assert.equal(check('title', 'startsWith', 'fix the', m), true)
  assert.equal(check('title', 'startsWith', 'the', m), false)
  assert.equal(check('title', 'is', 'fix the login redirect', m), true)
  assert.equal(check('title', 'is', 'fix the login', m), false)
  // Full-width letters fold to ASCII under NFKC.
  assert.equal(check('preview', 'contains', 'proj-12', m), true)
  const bare = it('bronos.gmail', 't2')
  assert.equal(check('preview', 'contains', 'x', bare), false)
  assert.equal(check('preview', 'notContains', 'x', bare), true)
  assert.equal(check('preview', 'is', 'x', bare), false)
  assert.equal(check('preview', 'startsWith', 'x', bare), false)
})

test('from, source and sourceKind: is, isNot, contains, endsWith, in', () => {
  const m = it('bronos.gmail', 'f1', { extra: { from: { name: 'Lead Person', address: 'Lead@example.com' } } })
  assert.equal(check('from.address', 'is', 'lead@example.com', m), true)
  assert.equal(check('from.address', 'endsWith', '@example.com', m), true)
  assert.equal(check('from.address', 'endsWith', '@example.org', m), false)
  assert.equal(check('from.address', 'in', ['a@example.com', 'LEAD@example.com'], m), true)
  assert.equal(check('from.address', 'in', ['a@example.com'], m), false)
  assert.equal(check('from.name', 'contains', 'lead', m), true)
  assert.equal(check('from.name', 'is', 'lead', m), false)
  const anon = it('bronos.gmail', 'f2')
  assert.equal(check('from.name', 'is', 'lead', anon), false)
  assert.equal(check('from.address', 'in', ['lead@example.com'], anon), false)
  assert.equal(check('source', 'is', 'bronos.gmail', m), true)
  assert.equal(check('source', 'isNot', 'bronos.gmail', m), false)
  assert.equal(check('source', 'isNot', 'bronos.chat', m), true)
  assert.equal(check('source', 'in', ['bronos.chat', 'bronos.gmail'], m), true)
  assert.equal(check('sourceKind', 'is', 'mail', m), true)
  assert.equal(check('sourceKind', 'isNot', 'mail', m), false)
  assert.equal(check('sourceKind', 'in', ['chat', 'issues'], m), false)
})

test('to (absent = none), mentionsMe (absent = false), read (true, false, null)', () => {
  const dm = it('bronos.chat', 'c1', { extra: { to: 'direct', mentionsMe: true } })
  const plain = it('bronos.chat', 'c2', { read: null })
  assert.equal(check('to', 'is', 'direct', dm), true)
  assert.equal(check('to', 'is', 'none', dm), false)
  assert.equal(check('to', 'is', 'none', plain), true)
  assert.equal(check('to', 'in', ['group', 'none'], plain), true)
  assert.equal(check('to', 'in', ['group', 'cc'], dm), false)
  assert.equal(check('mentionsMe', 'is', true, dm), true)
  assert.equal(check('mentionsMe', 'is', false, plain), true)
  assert.equal(check('mentionsMe', 'is', true, plain), false)
  assert.equal(check('read', 'is', false, dm), true)
  assert.equal(check('read', 'is', true, dm), false)
  assert.equal(check('read', 'is', null, plain), true)
  assert.equal(check('read', 'is', false, plain), false)
})

test('place: kind, name, status with is, contains, in', () => {
  const j = it('bronos.jira', 'PROJ-12', { extra: { place: { kind: 'project', name: 'PROJ', status: 'In Progress' } } })
  assert.equal(check('place.kind', 'is', 'project', j), true)
  assert.equal(check('place.name', 'in', ['ops', 'proj'], j), true)
  assert.equal(check('place.status', 'contains', 'progress', j), true)
  assert.equal(check('place.status', 'is', 'done', j), false)
  const none = it('bronos.jira', 'PROJ-13')
  assert.equal(check('place.name', 'is', 'proj', none), false)
  assert.equal(check('place.status', 'in', ['done'], none), false)
})

test('labels: has, hasNot, hasPrefix, case-insensitive; no labels has nothing', () => {
  const j = it('bronos.jira', 'PROJ-12', { labels: ['assigned', 'Priority:High', 'due:2026-11-06'] })
  assert.equal(check('labels', 'has', 'priority:high', j), true)
  assert.equal(check('labels', 'has', 'priority', j), false)
  assert.equal(check('labels', 'hasNot', 'mentioned', j), true)
  assert.equal(check('labels', 'hasNot', 'ASSIGNED', j), false)
  assert.equal(check('labels', 'hasPrefix', 'due:2026-11', j), true)
  assert.equal(check('labels', 'hasPrefix', 'type:', j), false)
  const bare = it('bronos.jira', 'PROJ-13')
  assert.equal(check('labels', 'has', 'assigned', bare), false)
  assert.equal(check('labels', 'hasNot', 'assigned', bare), true)
})

test('time: newerThan and olderThan in minutes from now', () => {
  const recent = it('bronos.chat', 'c1', { time: NOW - 30 * 60000 })
  const old = it('bronos.chat', 'c2', { time: NOW - 3 * HOUR })
  assert.equal(check('time', 'newerThan', 60, recent), true)
  assert.equal(check('time', 'newerThan', 60, old), false)
  assert.equal(check('time', 'olderThan', 120, old), true)
  assert.equal(check('time', 'olderThan', 120, recent), false)
})

// --- placing ---------------------------------------------------------------------------------

test('the text of a condition and what the item had, for the dry run and the log', () => {
  const m = it('bronos.jira', 'j1', { labels: ['a', 'b'], extra: { place: { kind: 'project', name: 'PROJ' } } })
  assert.equal(C.conditionText(C.conditionOf({ field: 'to', op: 'in', value: ['direct', 'group'] })), 'to in direct, group')
  assert.equal(C.actualText(C.conditionOf({ field: 'place.name', op: 'is', value: 'x' }), m, 'issues', NOW), 'PROJ')
  assert.equal(C.actualText(C.conditionOf({ field: 'labels', op: 'has', value: 'x' }), m, 'issues', NOW), 'a, b')
  assert.equal(C.actualText(C.conditionOf({ field: 'place.status', op: 'is', value: 'x' }), m, 'issues', NOW), 'none')
  assert.equal(C.actualText(C.conditionOf({ field: 'time', op: 'olderThan', value: 5 }), m, 'issues', NOW), '60 min ago')
})
