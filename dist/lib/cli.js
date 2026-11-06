'use strict'
// `ccc autopilot ...`: argument parsing and the printed text. Pure: the host does the work. Titles
// and ids come from other plugins (untrusted) and rule text from the person's files, so every line
// printed here is one line, free of control characters, and cut.

const { RUN_ID } = require('./prompt')
const S = require('./schema')

const LOG_DEFAULT = 20
const LOG_MAX = 200
const MAX_TITLE = 100

const HELP = `ccc autopilot: when a feed item matches one of your rules, start a Claude session on it, or run one of
the item's own actions with no session (bronos.autopilot)

  ccc autopilot [status]           on or off, the rules folders, the rules, problems and the last 5 runs
  ccc autopilot on                 switch on: items in the feeds now are the baseline, only new or changed ones fire
  ccc autopilot off                switch off: nothing fires (the dry run still works)
  ccc autopilot log [n]            the last n log entries (default ${LOG_DEFAULT}, at most ${LOG_MAX}), newest first
  ccc autopilot test [rule|<json>|-] [--at <n>] [--jev] [--jira] [--project|--global]
                                   dry run: which current feed items each rule (or the one named, or the rule
                                   given as JSON and not stored) would fire on and why; no session is started,
                                   Jev is asked only with --jev, and the Jira
                                   issue of a jira.* condition is looked up (read-only) only with --jira
  ccc autopilot reload             read both rules files and the playbooks again and list the problems
  ccc autopilot format             the rule and playbook format: every field, its type and limits, an example
  ccc autopilot rules [--project|--global]
                                   the numbered entries of each level's ${S.RULES_FILE} (on or off, what each checks)
  ccc autopilot rules export [--project|--global]
                                   one level's ${S.RULES_FILE} as JSON; without a level { "project": [...], "global": [...] }
  ccc autopilot rules add <json|-> [--at <n>]
                                   add one rule (off unless the JSON says "enabled": true; needs its playbook)
  ccc autopilot rules set <n|id> <json|->
                                   replace a rule (keeps its id and on/off when the JSON has none)
  ccc autopilot rules rm <n|id>    remove a rule
  ccc autopilot rules move <n|id> <to>
                                   move a rule to position <to> in its level's file
  ccc autopilot rules enable <n|id>   switch a rule on (it then fires on new items while Autopilot is on)
  ccc autopilot rules disable <n|id>  switch a rule off
  ccc autopilot playbooks [--project|--global]
                                   the playbook files of each level and the rules that use each
  ccc autopilot playbooks show <name>
  ccc autopilot playbooks set <name> <text|->
                                   create or replace a playbook (Markdown; "-" reads stdin)
  ccc autopilot playbooks rm <name>   delete a playbook no rule names
  ccc autopilot base [show] [--project|--global]
                                   the level's ${S.BASE_FILE}, your standing instructions for every session (both
                                   levels without a flag)
  ccc autopilot base set <text|-> [--project|--global]
                                   write that level's ${S.BASE_FILE} (Markdown, at most ${S.MAX_BASE_BYTES / 1024} KiB; "-" reads
                                   stdin; an empty text removes the file)
  ccc autopilot stop <run>         run by an Autopilot session in its own tab: send it no more updates
                                   (accepted only from that run's tab; the session's first message names <run>)
  ccc autopilot help               this text

Two rule levels, each a folder with ${S.RULES_FILE} and playbooks/<name>.md: project rules (the project
setting "Project rules folder", empty by default; a relative path is read from the project folder) run in this
project only, global rules (the app setting "Global rules folder", default ~/.config/cc-cockpit-autopilot) in
every project. Project rules are checked first, then global ones; the first that holds wins. A rule is named
<level>:<id> (project:down, global:down): ids are unique per level only. Reads show both levels; every write
(rules add|set|rm|move|enable|disable, playbooks set|rm) and a JSON test take --project or --global when both
folders exist (a <level>:<id> selector names the level too). A rule's playbook is read from its own level's
playbooks/. A v1 rules.json is never read: \`ccc autopilot\` notes it, and Claude can port it on request.

A rule has a playbook (a Claude session; "mode": "investigate" changes nothing, "act" may carry out the
playbook's "${S.ALLOWED_ACTIONS}" only) or an "act" (one of the item's own actions, such as markRead, run by
Autopilot on new items with no session). ${S.BASE_FILE} in a level's folder goes into every session prompt after
the fixed frame (global first, then project). \`ccc autopilot format\` has the details.

Edit the files by hand, with Claude, or in the Autopilot panel (Rules and Playbooks). The commands above write
through the same checks as the panel (a refused edit stores nothing). A <json|-> is the JSON as one quoted
argument, or "-" to read it from stdin; stdin is read only for a "-" argument. A number is the position in the
level's ${S.RULES_FILE} as "rules" prints it; digits only is always a position, anything else an id. Exit codes:
0 done, 1 refused (nothing stored), 2 a usage error, bad JSON or a missing level. A rule that is on can make
Claude sessions start on their own: test it first. See the plugin's README.
`

const USAGE = 'Usage: ccc autopilot [status] | on | off | log [n] | test [rule|<json>|-] [--at <n>] [--jev] [--jira] [--project|--global] | reload | format | rules [export|add|set|rm|move|enable|disable] [--project|--global] | playbooks [show|set|rm] [--project|--global] | base [show|set] [--project|--global] | stop <run> | help'

/** One line, no control characters (C0, DEL, C1, line and paragraph separators), cut to `max`. */
function oneLine(s, max) {
  const t = String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** A position word (digits, 1 to 999999) as a number, or null. */
function placeOf(w) {
  return typeof w === 'string' && /^\d{1,6}$/.test(w) && Number(w) >= 1 ? Number(w) : null
}

/** A rule number or id as typed: one word, not an option, a plain length. */
const selOf = (w) => (typeof w === 'string' && w.length >= 1 && w.length <= 64 && !w.startsWith('-') && !/[\u0000-\u001f\u007f]/.test(w) ? w : null)

const LEVEL_FLAGS = Object.freeze({ '--project': 'project', '--global': 'global' })

/**
 * Take `--project` / `--global` out of `args`: `{ level, rest }` (level null when neither) or
 * `{ error }`. Both, or one twice, is an error: a write must go to exactly one file.
 */
function levelFlag(args, usage) {
  let level = null
  const rest = []
  for (const a of args) {
    if (!Object.hasOwn(LEVEL_FLAGS, a)) {
      rest.push(a)
      continue
    }
    if (level !== null) return usage('give --project or --global once')
    level = LEVEL_FLAGS[a]
  }
  return { level, rest }
}

/**
 * A selector with its level (`project:down`) split, or a plain one kept: `{ level, sel }`, level null
 * for a plain one; null when the part before ":" is not a level. A rule id has no ":" (RULE_ID).
 */
function splitSel(w) {
  if (typeof w !== 'string') return null
  const i = w.indexOf(':')
  if (i < 0) return { level: null, sel: w }
  const level = w.slice(0, i)
  return S.LEVELS.includes(level) ? { level, sel: w.slice(i + 1) } : null
}

/** The level a `level:id` selector names, checked against the flag's: `{ level, sel }` or `{ error }`. */
function selWithLevel(w, flag, usage, what) {
  const s = splitSel(w)
  if (!s || selOf(s.sel) === null) return usage(`${what}: the argument is a rule number or id (or project:<id> / global:<id>)`)
  if (s.level && flag && s.level !== flag) return usage(`${w} is a ${s.level} rule, but --${flag} was given`)
  return { level: s.level || flag, sel: s.sel }
}

/** `-` is stdin; any other word is the text itself. */
const inputOf = (w) => (w === '-' ? { stdin: true } : { text: w })

const RULES_SUBS = ['list', 'export', 'add', 'set', 'rm', 'move', 'enable', 'disable']
const PLAYBOOKS_SUBS = ['list', 'show', 'set', 'rm']
const BASE_SUBS = ['show', 'set']

/** `rules ...` (see HELP). Resolves `{ cmd: 'rules', sub, level?, sel?, input?, at?, to? }` or `{ error }`. */
function parseRules(all, usage) {
  const f = levelFlag(all, usage)
  if (f.error) return f
  const [sub = 'list', ...args] = f.rest
  const lv = f.level ? { level: f.level } : {}
  if (!RULES_SUBS.includes(sub)) return usage(`unknown rules command "${oneLine(sub, 40)}"`)
  let at = null
  const a = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--at') {
      a.push(args[i])
      continue
    }
    if (sub !== 'add') return usage('--at goes with rules add (use rules move to move a rule)')
    if (at !== null) return usage('--at given twice')
    at = placeOf(args[++i])
    if (at === null) return usage('--at takes a position (a number from 1)')
  }
  const out = { cmd: 'rules', sub, ...lv }
  const want = (n, what) => (a.length === n ? null : usage(`rules ${sub} takes ${what}`))
  // `project:down` names its level; the result carries it as `level` and the plain id as `sel`.
  const withSel = (w, what, extra) => {
    const s = selWithLevel(w, f.level, usage, what)
    if (s.error) return s
    return { ...out, ...(s.level ? { level: s.level } : {}), sel: s.sel, ...extra }
  }
  if (sub === 'list' || sub === 'export') return want(0, 'no arguments') || out
  if (sub === 'add') {
    const e = want(1, 'one JSON rule (as one argument, or - for stdin)')
    if (e) return e
    return { ...out, input: inputOf(a[0]), at }
  }
  if (sub === 'set') {
    const e = want(2, 'a number or id, then the JSON rule (or -)')
    if (e) return e
    return withSel(a[0], 'rules set', { input: inputOf(a[1]) })
  }
  if (sub === 'move') {
    const e = want(2, 'a number or id, then the place to move it to')
    if (e) return e
    const to = placeOf(a[1])
    if (to === null) return usage('rules move <n|id> <to>: <to> is a position (a number from 1)')
    return withSel(a[0], 'rules move', { to })
  }
  const e = want(1, 'a rule number or id')
  if (e) return e
  return withSel(a[0], `rules ${sub}`, {})
}

/** `playbooks ...` (see HELP). The name is checked by the loader's own pattern, so no path gets through. */
function parsePlaybooks(all, usage) {
  const f = levelFlag(all, usage)
  if (f.error) return f
  const [sub = 'list', ...a] = f.rest
  if (!PLAYBOOKS_SUBS.includes(sub)) return usage(`unknown playbooks command "${oneLine(sub, 40)}"`)
  const out = { cmd: 'playbooks', sub, ...(f.level ? { level: f.level } : {}) }
  if (sub === 'list') return a.length ? usage('playbooks takes no arguments') : out
  const n = sub === 'set' ? 2 : 1
  if (a.length !== n) return usage(sub === 'set' ? 'playbooks set takes a name, then the text (or - for stdin)' : `playbooks ${sub} takes a name`)
  if (!S.PLAYBOOK_NAME.test(a[0])) return usage(`"${oneLine(a[0], 40)}" is not a playbook name (1-64 letters, digits, "_" or "-", no dot, no slash)`)
  return sub === 'set' ? { ...out, name: a[0], input: inputOf(a[1]) } : { ...out, name: a[0] }
}

/**
 * `base [show|set <text|->]` (see HELP): `{ cmd: 'base', sub, level?, input? }` or `{ error }`. A set's
 * level is checked by the host (writeLevel), as for every write.
 */
function parseBase(all, usage) {
  const f = levelFlag(all, usage)
  if (f.error) return f
  const [sub = 'show', ...a] = f.rest
  if (!BASE_SUBS.includes(sub)) return usage(`unknown base command "${oneLine(sub, 40)}"`)
  const out = { cmd: 'base', sub, ...(f.level ? { level: f.level } : {}) }
  if (sub === 'show') return a.length ? usage('base show takes no arguments (add --project or --global for one level)') : out
  if (a.length !== 1) return usage('base set takes the text (or - for stdin; an empty text removes the file)')
  return { ...out, input: inputOf(a[0]) }
}

/**
 * The text of an `{ stdin: true } | { text }` input: stdin as the app handed it (only a `-` argument
 * makes the app read it), else the argument. Resolves `{ text }` or `{ error }` (exit 2).
 */
function inputText(input, stdin) {
  if (input.text !== undefined) return { text: input.text }
  if (typeof stdin !== 'string' || !stdin.trim()) return { error: 'nothing on stdin: pipe the text in after "-" (echo \'{...}\' | ccc autopilot rules add -)' }
  return { text: stdin }
}

/** A JSON object from an input (a rule): `{ value }` or `{ error }` (exit 2; nothing was stored). */
function jsonInput(input, stdin) {
  const t = inputText(input, stdin)
  if (t.error) return t
  let value
  try {
    value = JSON.parse(t.text.replace(/^﻿/, ''))
  } catch (e) {
    return { error: `not valid JSON: ${oneLine(e && e.message, 200)} (one object, no comments or trailing commas)` }
  }
  if (!S.isObj(value)) return { error: 'a rule is one JSON object ({ "id": ..., "sources": [...], ... })' }
  return { value }
}

/** @returns {{ cmd: string, n?: number, rule?: string, jev?: boolean, run?: string } | { error: string }} */
function parse(argv) {
  const [cmd = 'status', ...rest] = argv
  const usage = (m) => ({ error: `${m}\n${USAGE}` })
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return { cmd: 'help' }
  if (['status', 'on', 'off', 'reload', 'format'].includes(cmd)) return rest.length ? usage(`${cmd} takes no arguments`) : { cmd }
  if (cmd === 'log') {
    if (rest.length > 1) return usage('log takes at most one number')
    if (!rest.length) return { cmd, n: LOG_DEFAULT }
    if (!/^\d{1,3}$/.test(rest[0]) || Number(rest[0]) < 1 || Number(rest[0]) > LOG_MAX) return usage(`log takes a number from 1 to ${LOG_MAX}`)
    return { cmd, n: Number(rest[0]) }
  }
  if (cmd === 'stop') {
    // The run id goes into the log and an answer: checked by the same pattern the prompt's command uses.
    if (rest.length !== 1) return usage('stop takes one run id')
    if (!RUN_ID.test(rest[0])) return usage(`"${oneLine(rest[0], 40)}" is not a run id`)
    return { cmd, run: rest[0] }
  }
  if (cmd === 'rules') return parseRules(rest, usage)
  if (cmd === 'playbooks') return parsePlaybooks(rest, usage)
  if (cmd === 'base') return parseBase(rest, usage)
  if (cmd === 'test') {
    const f = levelFlag(rest, usage)
    if (f.error) return f
    let rule = null
    let jev = false
    let jira = false
    let input = null
    let at = null
    for (let i = 0; i < f.rest.length; i++) {
      const a = f.rest[i]
      if (a === '--jev') {
        if (jev) return usage('--jev given twice')
        jev = true
      } else if (a === '--jira') {
        if (jira) return usage('--jira given twice')
        jira = true
      } else if (a === '--at') {
        if (at !== null) return usage('--at given twice')
        const n = placeOf(f.rest[++i])
        if (n === null) return usage('--at takes a position (a number from 1)')
        at = n
      } else if (a === '-' || a.startsWith('{')) {
        // A rule id starts with a letter or a digit, so `{` and a lone `-` can only be the JSON input.
        if (rule !== null || input !== null) return usage('test takes one rule id or one JSON rule')
        input = a === '-' ? { stdin: true } : { text: a }
      } else if (a.startsWith('-')) return usage(`unknown option "${oneLine(a, 40)}" (test takes --jev, --jira, --at, --project and --global)`)
      else if (rule !== null || input !== null) return usage('test takes at most one rule id')
      else {
        // A stored rule as `down` or `project:down`; the flag and the prefix must agree.
        const s = splitSel(a)
        if (!s) return usage(`"${oneLine(a, 40)}": a rule is an id or project:<id> / global:<id>`)
        if (s.level && f.level && s.level !== f.level) return usage(`${oneLine(a, 72)} is a ${s.level} rule, but --${f.level} was given`)
        rule = a
      }
    }
    if (at !== null && input === null) return usage('--at goes with a JSON rule: test <json|-> --at <n>')
    return { cmd, rule, jev, jira, ...(f.level ? { level: f.level } : {}), ...(input ? { input } : {}), ...(at !== null ? { at } : {}) }
  }
  return usage(`unknown command "${oneLine(cmd, 40)}"`)
}

const p2 = (n) => String(n).padStart(2, '0')
/** "2026-11-03 14:05" in local time. */
function when(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** One log entry as a line. */
function entryLine(e) {
  const t = when(e.at)
  if (e.step === 'switch') return `${t} ${oneLine(e.note, 200)}`
  const item = `${oneLine(e.source, 60)} ${oneLine(e.itemId, 80)} "${oneLine(e.title, MAX_TITLE)}"`
  const score = typeof e.score === 'number' ? ` ${e.score.toFixed(2)}` : ''
  // The rules below the item's rule that would have held too (first rule wins: they never ran).
  const also = Array.isArray(e.also) && e.also.length ? `; also matched: ${oneLine(e.also.join(', '), 200)}` : ''
  // An act rule's action that ran (0.3.0): what it did, "marked read: <title>".
  if (e.step === 'act' && e.outcome) return `${t} ${oneLine(e.rule, 72)} ${oneLine(e.source, 60)} ${oneLine(e.itemId, 80)}: ${oneLine(e.outcome, 200)}${also}`
  // A run event (a tab closed, a restored tab re-adopted, an early end): a note, neither a fire nor a skip.
  if (e.note) return `${t} ${oneLine(e.rule, 72)} ${oneLine(e.source, 60)} ${oneLine(e.itemId, 80)}: ${oneLine(e.note, 200)}`
  if (e.tabId) return `${t} ${oneLine(e.rule, 72)} ${item}: opened tab ${oneLine(e.tabId, 60)} (${oneLine(e.step, 10)}${score})${also}`
  return `${t} ${oneLine(e.rule, 72)} ${item}: skipped (${oneLine(e.step, 10)}${score}): ${oneLine(e.skip, 200)}${also}`
}

function formatLog(entries, n) {
  if (!entries.length) return 'The log is empty.\n'
  return `${entries.slice(0, n).map(entryLine).join('\n')}\n`
}

/** Problems first, then each rule (by its ref) with its warnings (indented), then the plain notes. */
function rulesBlock(s) {
  const out = []
  if (s.problems.length) {
    out.push(`Problems (${s.problems.length}):`)
    for (const p of s.problems) out.push(`  ! ${oneLine(p, 300)}`)
  }
  if (!s.rules.length) out.push('No valid rule.')
  for (const r of s.rules) {
    out.push(`  ${r.on ? '•' : '-'} ${oneLine(r.ref, 72)}${r.on ? '' : ' (off)'}: ${oneLine(r.summary, 200)}`)
    for (const w of r.warnings) out.push(`      ⚠ ${oneLine(w, 300)}`)
  }
  // A v1 rules.json that is not read: a note, never a problem (design-v2 "Migration from v1").
  for (const h of s.hints || []) out.push(`Note: ${oneLine(h, 400)}`)
  return out
}

/** One level's folder line: where its rules are read from, or why there are none. */
function folderLine(l) {
  const where = l.level === 'global' ? 'the app setting "Global rules folder" is empty' : 'the project setting "Project rules folder" is empty'
  // Whether the level's base.md is in every session's prompt (a problem one is in the problem lines).
  const base = l.folder && l.base ? `; ${S.BASE_FILE} in use (${l.base.size} bytes)` : ''
  return `${l.label} rules: ${l.folder ? oneLine(l.folder, 300) : `none (${where})`}${base}`
}

function formatStatus(s) {
  const on = s.rules.filter((r) => r.on).length
  const by = s.levels.filter((l) => l.folder).map((l) => `${s.rules.filter((r) => r.level === l.level).length} ${l.level}`).join(', ')
  const out = [
    `Autopilot: ${s.on ? 'on' : 'off'}${s.on ? '' : ' (nothing fires; ccc autopilot on to start)'}`,
    ...s.levels.map(folderLine),
    `Rules: ${s.rules.length} valid${by ? ` (${by})` : ''}, ${on} on${s.problems.length ? `, ${s.problems.length} problem${s.problems.length === 1 ? '' : 's'}` : ''}; project rules are checked first`,
    ...rulesBlock(s),
  ]
  const srcErr = s.sources.filter((x) => x.error)
  out.push(`Sources: ${s.sources.length ? s.sources.map((x) => oneLine(x.label, 24)).join(', ') : 'none (enable a plugin that offers an inbox feed)'}`)
  for (const x of srcErr) out.push(`  ! ${oneLine(x.error, 300)}`)
  out.push(s.log.length ? 'Last runs:' : 'No runs yet.')
  for (const e of s.log.slice(0, 5)) out.push(`  ${entryLine(e)}`)
  return `${out.join('\n')}\n`
}

function formatReload(s) {
  const where = s.levels.filter((l) => l.folder).map((l) => `${l.level} ${oneLine(l.folder, 300)}`).join(', ') || 'no rules folder'
  return `Read ${where}: ${s.rules.length} valid rule${s.rules.length === 1 ? '' : 's'}${s.problems.length ? `, ${s.problems.length} problem${s.problems.length === 1 ? '' : 's'}` : ', no problem'}.\n${rulesBlock(s).join('\n')}\n`
}

/** The dry run's answer (host dryRun). */
function formatDry(d) {
  const head = `Dry run over ${d.items} item${d.items === 1 ? '' : 's'} from ${d.sources} source${d.sources === 1 ? '' : 's'}, ${d.rules} rule${d.rules === 1 ? '' : 's'}${d.jev ? ', with Jev' : ' (Jev not asked: add --jev)'}${d.jira ? ', with Jira lookups' : d.jiraRules ? ' (Jira not looked up: add --jira)' : ''}. No session is started.`
  const out = [head]
  // A rule given as JSON (not stored): say where it stood and that it was tested as on.
  if (d.candidate) out.push(`Rule ${oneLine(d.candidate.id, 72)} is the JSON you gave, not stored: tested as on, ${d.candidate.replaced ? `in the place of the stored rule ${oneLine(d.candidate.id, 72)}` : `at position ${d.candidate.at} of its level's file`}.`)
  if (d.candidate) for (const w of d.candidate.warnings) out.push(`  ⚠ ${oneLine(w, 300)}`)
  if (!d.on) out.push('Autopilot is off: even a "would fire" opens nothing until it is on.')
  if (!d.results.length) out.push('No rule matches a current item.')
  for (const r of d.results) {
    out.push(`${oneLine(r.rule, 72)}  ${oneLine(r.source, 60)} ${oneLine(r.itemId, 80)} "${oneLine(r.title, MAX_TITLE)}"`)
    out.push(`    ${r.fire ? 'would fire' : 'would not fire'}: ${oneLine(r.verdict, 200)} (matched ${oneLine(r.why.join(', '), 200)})`)
  }
  if (d.cut) out.push(`(${d.cut} more not shown)`)
  return `${out.join('\n')}\n`
}

/**
 * The numbered entries of each level's rules file, valid or not (`status().levels[].entries`), for
 * `rules`; `only` keeps one level. Numbers are positions in that level's file, as the edits take them.
 */
function formatRules(s, only = null) {
  const out = []
  for (const l of s.levels.filter((x) => !only || x.level === only)) {
    if (!l.folder) {
      out.push(folderLine(l))
      continue
    }
    out.push(`${l.label} rules in ${oneLine(l.folder, 300)}: ${l.entries.length} entr${l.entries.length === 1 ? 'y' : 'ies'} in ${S.RULES_FILE}, numbered as in the file`)
    if (!l.entries.length) for (const p of s.problems.filter((x) => x.startsWith(`${l.level}:`))) out.push(`  ! ${oneLine(p, 300)}`)
    if (l.hint) out.push(`  Note: ${oneLine(l.hint, 300)}`)
    for (const e of l.entries) {
      const n = String(e.index + 1).padStart(3)
      const id = e.id === null ? `rule ${e.index + 1}` : oneLine(e.ref || e.id, 72)
      if (e.ok) out.push(`${n} ${e.on ? '•' : '-'} ${id}${e.on ? '' : ' (off)'}: ${oneLine(e.summary, 200)}`)
      else out.push(`${n} ! ${id}: ${oneLine(e.problem || 'not valid', 300)} (does not run)`)
      for (const w of e.warnings) out.push(`        ⚠ ${oneLine(w, 300)}`)
    }
    if (!l.entries.length && l.folderState === 'ok') out.push(`  No rules yet. Add one: ccc autopilot rules add --${l.level} '{...}' (ccc autopilot format shows the fields).`)
  }
  out.push(`Autopilot is ${s.on ? 'on' : 'off'}; project rules are checked first, then global ones.`)
  return `${out.join('\n')}\n`
}

/** `playbooks`: per level, one line per file with the rules naming it (`levels`: status().levels). */
function formatPlaybooks(levels) {
  const out = []
  for (const l of levels) {
    if (!l.folder) {
      out.push(folderLine(l))
      continue
    }
    const dir = `${oneLine(l.folder, 300)}/${S.PLAYBOOKS_DIR}`
    if (!l.playbookFiles.length) {
      out.push(`No ${l.level} playbooks in ${dir}. Write one: ccc autopilot playbooks set --${l.level} <name> -`)
      continue
    }
    out.push(`${l.label} playbooks in ${dir}:`)
    for (const f of l.playbookFiles) {
      const use = f.usedBy.length ? `used by ${oneLine(f.usedBy.join(', '), 200)}` : 'used by no rule'
      out.push(`  ${oneLine(f.name, 64)}  ${f.size} bytes, ${use}${f.link ? ' (a link: not edited here)' : ''}${f.invalid ? ' (its name cannot be used by a rule)' : ''}`)
    }
  }
  return `${out.join('\n')}\n`
}

module.exports = { HELP, USAGE, LOG_DEFAULT, MAX_TITLE, RULES_SUBS, PLAYBOOKS_SUBS, BASE_SUBS, oneLine, splitSel, parse, inputText, jsonInput, when, entryLine, formatLog, formatStatus, formatReload, formatDry, formatRules, formatPlaybooks }
