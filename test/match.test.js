'use strict'
// The field part of a rule (sources, then `when`), the decision over the rules in order (first rule
// wins, Jev waits, also matched from cached answers only, hours before Jev) and the outsider-trigger
// warning. The condition cases themselves are conditions.test.js.
const test = require('node:test')
const assert = require('node:assert/strict')
const { readRules } = require('../dist/lib/rules')
const { matchRule, evaluate, outsiderWarning } = require('../dist/lib/match')
const { rule, item, NOW } = require('./fakes')

const one = (o) => readRules([rule('r', o)]).rules[0]
const many = (...raw) => readRules(raw).rules
/** A v2 item as the store has it. */
const it = (o = {}) => item('SUP-123', { title: 'Site DOWN on example.com', from: 'Ann Example', where: 'Alerts', ...o })
const kindOf = (id) => ({ 'bronos.gmail': 'mail', 'bronos.chat': 'chat' })[id] || null

test('sources first, then every condition must hold; case does not matter', () => {
  const r = one({
    sources: ['bronos.chat', 'bronos.jira'],
    when: [{ field: 'place.name', op: 'contains', value: 'alerts' }, { field: 'from.name', op: 'in', value: ['bob', 'ann example'] }, { field: 'title', op: 'contains', value: 'down' }],
  })
  const o = { kindOf, now: NOW }
  assert.deepEqual(matchRule(r, 'bronos.chat', it(), o), { why: ['source bronos.chat', 'place.name contains alerts', 'from.name in bob, ann example', 'title contains down'] })
  assert.ok(matchRule(r, 'bronos.jira', it(), o), 'the second listed source')
  assert.equal(matchRule(r, 'bronos.gmail', it(), o), null, 'another source: the conditions are not even read')
  assert.equal(matchRule(r, 'bronos.chat', it({ where: 'Random' }), o), null)
  assert.equal(matchRule(r, 'bronos.chat', it({ from: 'Carol' }), o), null)
  assert.equal(matchRule(r, 'bronos.chat', it({ title: 'All fine' }), o), null)
})

test('["*"] is any source; the condition `source` and `sourceKind` read the pluginId and its kind', () => {
  const any = one({ sources: ['*'], when: [{ field: 'source', op: 'is', value: 'bronos.gmail' }, { field: 'sourceKind', op: 'is', value: 'mail' }] })
  assert.deepEqual(matchRule(any, 'bronos.gmail', it(), { kindOf, now: NOW }).why, ['any source', 'source is bronos.gmail', 'sourceKind is mail'])
  assert.equal(matchRule(any, 'bronos.chat', it(), { kindOf, now: NOW }), null)
  assert.equal(matchRule(any, 'bronos.gmail', it(), { kindOf: () => null, now: NOW }), null, 'an unknown kind is "other"')
})

test('an empty when is a sources-only rule: every item of the sources holds', () => {
  const r = one({ sources: ['bronos.jira'], when: [] })
  assert.deepEqual(matchRule(r, 'bronos.jira', it()), { why: ['source bronos.jira'] })
  assert.equal(matchRule(r, 'bronos.chat', it()), null)
})

test('mentionsMe and time conditions; no pattern syntax', () => {
  const m = one({ when: [{ field: 'mentionsMe', op: 'is', value: true }] })
  assert.ok(matchRule(m, 'p.x', it({ mentionsMe: true })))
  assert.equal(matchRule(m, 'p.x', it()), null)
  assert.ok(matchRule(one({ when: [{ field: 'time', op: 'newerThan', value: 120 }] }), 'p.x', it(), { now: NOW }))
  assert.equal(matchRule(one({ when: [{ field: 'time', op: 'olderThan', value: 120 }] }), 'p.x', it(), { now: NOW }), null)
  // A regex-looking value is a literal substring.
  const lit = one({ when: [{ field: 'title', op: 'contains', value: '(a+)+$' }] })
  assert.equal(matchRule(lit, 'p.x', it({ title: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab' })), null)
  assert.ok(matchRule(lit, 'p.x', it({ title: 'see (a+)+$ here' })))
})

test('outsider warning: any source, or a mail source (by kind or by id); none for an internal source', () => {
  const kinds = { 'bronos.gmail': 'mail', 'bronos.jira': 'issues', 'acme.post': 'mail' }
  const k = (id) => kinds[id] || null
  assert.match(outsiderWarning(one({ sources: ['*'] }), k), /any source/)
  assert.match(outsiderWarning(one({ sources: ['bronos.gmail'] }), k), /bronos.gmail is mail/)
  assert.match(outsiderWarning(one({ sources: ['acme.post'] }), k), /acme.post is mail/)
  // Not running now: the id still tells.
  assert.match(outsiderWarning(one({ sources: ['acme.mailbox'] }), () => null), /acme.mailbox is mail/)
  assert.equal(outsiderWarning(one({ sources: ['bronos.jira', 'bronos.chat'] }), k), null)
})

// ---- evaluate: first rule wins, Jev waits ----

const ids = (list) => list.map((x) => x.rule.id)
/** A Jev stand-in: `answers[ruleId]` is `{ score }`, `{ pending: true }` or `{ unavailable }`; calls recorded. */
function jevOf(answers = {}, cached = {}) {
  const j = { asked: [], peeked: [] }
  j.answer = (r, pluginId, item) => {
    j.asked.push(r.id)
    return answers[r.id] || { pending: true }
  }
  j.cached = (r) => {
    j.peeked.push(r.id)
    return cached[r.id] || null
  }
  return j
}
const ev = (rules, j, o = {}) => evaluate(rules, 'bronos.jira', it(), { now: NOW, jevAnswer: j.answer, jevCached: j.cached, ...o })

test('evaluate: the first rule that holds decides; the rules below that hold too are "also matched"', () => {
  const rules = many(rule('a', { when: [{ field: 'title', op: 'contains', value: 'fine' }] }), rule('b'), rule('c'), rule('d', { sources: ['bronos.chat'] }), rule('e', { enabled: false }))
  const j = jevOf()
  const e = ev(rules, j)
  assert.equal(e.decision, 'fire')
  assert.equal(e.rule.id, 'b', 'a does not match; b is first of the rest')
  assert.deepEqual(e.why, ['any source', 'title contains down'])
  assert.deepEqual(ids(e.also), ['c'], 'd is another source, e is off')
  assert.deepEqual(ev(many(rule('x', { when: [{ field: 'title', op: 'is', value: 'nope' }] })), j), { decision: 'none', rule: null, why: [], also: [], trace: [] })
})

test('evaluate: a pending Jev answer holds the decision; lower rules do not fire', () => {
  const rules = many(rule('asked', { jev: { question: 'Down?', min: 0.7 } }), rule('plain'))
  const j = jevOf({ asked: { pending: true } })
  const e = ev(rules, j)
  assert.deepEqual([e.decision, e.rule.id], ['wait', 'asked'])
  assert.deepEqual(j.asked, ['asked'])
  // Answered yes: the Jev rule fires with its score; the plain one is also matched.
  const yes = ev(rules, jevOf({ asked: { score: 0.9 } }))
  assert.deepEqual([yes.decision, yes.rule.id, yes.score, ids(yes.also)], ['fire', 'asked', 0.9, ['plain']])
  // Answered no: it does not hold (traced with the score) and the next rule decides.
  const no = ev(rules, jevOf({ asked: { score: 0.2 } }))
  assert.deepEqual([no.decision, no.rule.id], ['fire', 'plain'])
  assert.deepEqual(no.trace.map((t) => [t.rule.id, t.step, t.score, t.skip]), [['asked', 'jev', 0.2, 'jev 0.20 is below 0.7']])
})

test('evaluate: Jev unavailable is a retry, never a fall-through to a lower rule', () => {
  const rules = many(rule('asked', { jev: { question: 'Down?', min: 0.7 } }), rule('plain'))
  const e = ev(rules, jevOf({ asked: { unavailable: 'jev failed: monthly cap reached' } }))
  assert.deepEqual([e.decision, e.rule.id, e.reason], ['retry', 'asked', 'jev failed: monthly cap reached'])
  assert.deepEqual(e.also, [])
  // No Jev function at all (a caller that gives none): unavailable, not "holds" or "does not hold".
  assert.equal(evaluate(rules, 'bronos.jira', it(), { now: NOW }).decision, 'retry')
})

test('evaluate: also matched reads cached answers only, never asks', () => {
  const rules = many(rule('plain'), rule('j1', { jev: { question: 'q1', min: 0.5 } }), rule('j2', { jev: { question: 'q2', min: 0.5 } }), rule('j3', { jev: { question: 'q3', min: 0.5 } }))
  const j = jevOf({}, { j1: { score: 0.8 }, j3: { score: 0.1 } })
  const e = ev(rules, j)
  assert.equal(e.rule.id, 'plain')
  assert.deepEqual(j.asked, [], 'no request for the log')
  assert.deepEqual(j.peeked, ['j1', 'j2', 'j3'])
  assert.deepEqual(e.also.map((a) => [a.rule.id, a.score]), [['j1', 0.8]], 'j2 has no cached answer, j3 is under min')
})

test('evaluate: hours before fields and Jev; outside the hours no request, traced, the next rule decides', () => {
  const at = (h) => new Date(2026, 10, 4, h).getTime()
  const rules = many(rule('night', { hours: { from: '22:00', to: '07:00' }, jev: { question: 'q', min: 0.5 } }), rule('day'))
  const j = jevOf({ night: { score: 0.9 } })
  const e = ev(rules, j, { now: at(12) })
  assert.deepEqual([e.decision, e.rule.id], ['fire', 'day'])
  assert.deepEqual(j.asked, [], 'Jev is not asked outside the hours')
  assert.deepEqual(e.trace.map((t) => [t.rule.id, t.step, t.skip]), [['night', 'hours', 'outside hours 22:00–07:00']])
  const night = ev(rules, j, { now: at(23) })
  assert.deepEqual([night.rule.id, ids(night.also)], ['night', ['day']])
  // An out-of-hours rule is not "also matched" either.
  const flip = ev(many(rule('day'), rule('night', { hours: { from: '22:00', to: '07:00' } })), jevOf(), { now: at(12) })
  assert.deepEqual(flip.also, [])
  // An off rule whose fields match is traced as off, never decides.
  const off = ev(many(rule('off', { enabled: false })), jevOf())
  assert.deepEqual([off.decision, off.trace.map((t) => t.step)], ['none', ['off']])
})
