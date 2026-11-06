'use strict'
// Small helpers feed.js and sources.js share (copied from Inbox's lib/util.js, with the timer pair
// injectable so a test's fake clock drives the call limits). A leaf: requires nothing.

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** An error (or anything thrown) as one short line for a log or a notice: cut to 300 characters. */
const why = (e) => String((e && e.message) || e || 'failed').slice(0, 300)

/** `p`, or a rejection after `ms` (a provider that never answers must not hold a read). */
function withTimeout(p, ms, what, timers = { setTimeout, clearTimeout }) {
  let t
  return Promise.race([
    Promise.resolve(p).finally(() => timers.clearTimeout(t)),
    new Promise((_, reject) => {
      t = timers.setTimeout(() => reject(new Error(`${what} did not answer in ${Math.round(ms / 1000)} s`)), ms)
    }),
  ])
}

module.exports = { isObj, why, withTimeout }
