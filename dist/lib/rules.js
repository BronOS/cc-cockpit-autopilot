'use strict'
// The person's rules and playbooks, read from their folders (design "v1 scope": files, read fresh on
// each check and on `ccc autopilot reload`). Two levels (design-v2 "Two rule levels"): the global folder
// (the app setting `globalFolder`, default ~/.config/cc-cockpit-autopilot) whose rules run in every
// project, and the project's folder (the project setting `projectFolder`, empty by default: no project
// rules). Each has its own autopilot-rules.json and playbooks/; project rules are checked first. Validated on every read the way Inbox validates its
// settings: a value of the wrong type makes that one rule a problem (reported in the panel and the
// CLI, skipped), the other rules keep working, unknown keys are dropped (with a warning, so a typo
// such as "txt" does not pass silently as "no text filter"), and nothing here throws on a broken
// file. There are no regexes from the person anywhere: matching is by field and case-insensitive
// substring (lib/match.js), since a regex in a rule would be a ReDoS risk in the host process.

const crypto = require('node:crypto')
const path = require('node:path')
const S = require('./schema')
const { conditionText } = require('./conditions')

// The rule format itself (constants, the check of one rule, readRules) is lib/schema.js, shared
// with the panel's form and `ccc autopilot format`; this file reads the folder.
const { RULES_FILE, V1_RULES_FILE, PLAYBOOKS_DIR, LEVELS, MAX_RULES, MAX_RULES_BYTES, MAX_PLAYBOOK_BYTES, LIMIT_DEFAULTS, JEV_MIN_DEFAULT, RULE_ID, PLAYBOOK_NAME, readRules, quote } = S
const DEFAULT_GLOBAL_FOLDER = '~/.config/cc-cockpit-autopilot'
// The hint for a folder that holds v1's rules.json and no autopilot-rules.json (design-v2 "Migration
// from v1"): never a problem (no badge, nothing is broken), and the file is never read or written.
const V1_HINT = `an old v1 ${V1_RULES_FILE} is in this folder and is not read (v2 reads ${RULES_FILE}); Claude can port it with the autopilot-rules skill on request`

/** The content hash of a file's text: what the host remembers to refuse a write over a hand edit. */
const hashText = (src) => crypto.createHash('sha256').update(src, 'utf8').digest('hex')

/**
 * A playbook file: the Markdown the session follows, after an optional front matter block. Since v2 the
 * rule names the model and effort (one playbook serves rules of different weight), so the block holds
 * nothing Autopilot reads: every key in it is dropped with a warning (a v1 `model:` line says so by name,
 * since a person who kept it would expect it to work).
 */
function parsePlaybook(src) {
  const warnings = []
  let body = src.replace(/^\ufeff/, '').replace(/\r\n/g, '\n')
  const fm = /^---\n([\s\S]{0,2000}?)\n---(?:\n|$)/.exec(body)
  if (fm) {
    body = body.slice(fm[0].length)
    for (const line of fm[1].split('\n')) {
      if (!line.trim()) continue
      const at = line.indexOf(':')
      const key = at < 0 ? line.trim() : line.slice(0, at).trim()
      warnings.push(key === 'model' ? 'model in a playbook is ignored: name the model in the rule' : `unknown front matter key ${quote(key, 40)} ignored`)
    }
  }
  return { body: body.trim(), warnings }
}

/** A folder setting as a path: `~` is the home folder, a relative path is read from `base`. */
function expandFolder(value, home, base) {
  const v = String(value).trim()
  if (v === '~') return path.resolve(home)
  if (v.startsWith('~/')) return path.resolve(home, v.slice(2))
  return path.resolve(base || home, v)
}

/**
 * The folder of one level from the settings: `{ folder, problem }`, `folder` null when the level has no
 * rules here. Global (`settings.app.globalFolder`): absent is the default folder, empty is "no global
 * rules" (the person cleared it on purpose), and a relative path is a problem, since an app setting has
 * no project to be relative to. Project (`settings.project.projectFolder`, which the app already gives a
 * global value and a per-project override): empty is no project rules, relative is read from the
 * project folder (so a global value such as `.autopilot` means that folder in every project).
 */
function levelFolder(level, settings, home, projectDir) {
  const scope = level === 'global' ? settings && settings.app : settings && settings.project
  const raw = scope ? scope[level === 'global' ? 'globalFolder' : 'projectFolder'] : undefined
  if (level === 'global' && (raw === undefined || raw === null)) return { folder: expandFolder(DEFAULT_GLOBAL_FOLDER, home), problem: null }
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (!v) return { folder: null, problem: null }
  if (level === 'global' && v !== '~' && !v.startsWith('~/') && !path.isAbsolute(v)) {
    return { folder: null, problem: `the global rules folder ${quote(v, 80)} must be an absolute path or start with ~ (an app setting has no project folder to start from)` }
  }
  return { folder: expandFolder(v, home, projectDir), problem: null }
}

/** "~/x" for a path under the home folder (shorter in the panel and the CLI). */
function displayPath(p, home) {
  const rel = path.relative(home, p)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel}` : p
}

const errText = (e) => (e && e.code === 'ENOENT' ? 'not found' : String((e && e.message) || e).slice(0, 200))

/**
 * Read one level's folder: autopilot-rules.json, then the playbook of every valid rule. Never throws: a
 * missing folder, file or playbook and broken JSON are problem lines; a rule whose playbook cannot be
 * read is a problem and left out, the others keep working. Resolves
 * `{ level, folder, rules, problems, hint, playbooks: Map<name, { body, model }>, folderState, raw, hash, entries }`:
 * `folderState` is 'ok' (the rules file was read), 'missing' (no folder), 'noRules' (no rules file) or
 * 'error'; `raw` the parsed file (null when unreadable), `hash` the content hash of the text read
 * (null when there is none), `entries` one record per entry of the file (schema.js readRules, with
 * the playbook problem and the final warnings filled in) for the panel's list. Each rule carries its
 * `level` and its `ref` (`project:r1`). `hint` is V1_HINT when the folder holds a v1 rules.json and
 * no rules file: then the missing file is not a problem either (an old file is not an error).
 * The problem lines are the file's own; loadLevels puts the level in front.
 */
async function loadFolder(folder, fsp, level = 'global') {
  const out = { level, folder, rules: [], problems: [], hint: null, playbooks: new Map(), folderState: 'ok', raw: null, hash: null, entries: [] }
  const file = path.join(folder, RULES_FILE)
  let src
  try {
    const st = await fsp.stat(file)
    if (!st.isFile()) throw new Error('not a file')
    if (st.size > MAX_RULES_BYTES) throw new Error(`over ${MAX_RULES_BYTES / 1024} KiB`)
    src = await fsp.readFile(file, 'utf8')
  } catch (e) {
    let folderMissing = false
    if (e && e.code === 'ENOENT') folderMissing = await fsp.stat(folder).then(() => false, () => true)
    out.folderState = folderMissing ? 'missing' : e && e.code === 'ENOENT' ? 'noRules' : 'error'
    // lstat only: the v1 file's presence is all that matters, and it is never opened.
    if (out.folderState === 'noRules' && (await fsp.lstat(path.join(folder, V1_RULES_FILE)).then(() => true, () => false))) {
      out.hint = V1_HINT
      return out
    }
    out.problems.push(folderMissing ? `folder ${folder} not found: create it with ${RULES_FILE} and ${PLAYBOOKS_DIR}/ (see the plugin's examples/)` : `${RULES_FILE}: ${errText(e)}`)
    return out
  }
  out.hash = hashText(src)
  let raw
  try {
    raw = JSON.parse(src.replace(/^\ufeff/, ''))
  } catch (e) {
    out.problems.push(`${RULES_FILE} is not valid JSON: ${errText(e)} (no comments or trailing commas)`)
    return out
  }
  out.raw = raw
  const { rules, problems, entries } = readRules(raw)
  out.entries = entries
  out.problems.push(...problems)
  const bad = new Map()
  for (const name of new Set(rules.map((r) => r.playbook))) {
    const pf = path.join(folder, PLAYBOOKS_DIR, `${name}.md`)
    try {
      const st = await fsp.stat(pf)
      if (!st.isFile()) throw new Error('not a file')
      if (st.size > MAX_PLAYBOOK_BYTES) throw new Error(`over ${MAX_PLAYBOOK_BYTES / 1024} KiB`)
      const pb = parsePlaybook(await fsp.readFile(pf, 'utf8'))
      if (!pb.body) throw new Error('empty')
      out.playbooks.set(name, pb)
    } catch (e) {
      bad.set(name, `playbook ${PLAYBOOKS_DIR}/${name}.md: ${errText(e)}`)
    }
  }
  for (const entry of entries) {
    const r = entry.rule
    if (!r) continue
    if (bad.has(r.playbook)) {
      out.problems.push(`rule ${quote(r.id, 40)}: ${bad.get(r.playbook)}; skipped`)
      entry.problem = bad.get(r.playbook)
      entry.rule = null
      continue
    }
    const pb = out.playbooks.get(r.playbook)
    const warnings = [...r.warnings, ...pb.warnings.map((w) => `playbook ${r.playbook}: ${w}`)]
    entry.rule = { ...r, level, ref: S.refOf(level, r.id), warnings }
    out.rules.push(entry.rule)
  }
  return out
}

/**
 * Both levels (design-v2 "Two rule levels"): `{ levels: { project, global }, rules, problems, hints }`.
 * A level is null when it has no folder, else its loadFolder result plus `playbookFiles` when `list`
 * (manage.js listPlaybooks, passed in to keep this file free of it) is given. `rules` is every valid
 * rule, project rules first (first rule wins, so a project's own rule beats a global one), `problems`
 * each line prefixed with its level, so "rule 2" says which file, and `hints` `{ level, folder, text }`
 * (the v1 file hint; the host words it with the folder as the person sees it). Never throws.
 */
async function loadLevels(settings, { home, projectDir, fs: fsp, list }) {
  const out = { levels: {}, rules: [], problems: [], hints: [] }
  for (const level of LEVELS) {
    const { folder, problem } = levelFolder(level, settings, home, projectDir)
    if (problem) out.problems.push(`${level}: ${problem}`)
    if (!folder) {
      out.levels[level] = null
      continue
    }
    let l
    try {
      l = await loadFolder(folder, fsp, level)
      l.playbookFiles = list ? await list(fsp, folder, l.raw) : []
    } catch (e) {
      // loadFolder answers problems itself; this is the belt for a bug in it.
      l = { level, folder, rules: [], problems: [`reading the folder failed: ${errText(e)}`], hint: null, playbooks: new Map(), folderState: 'error', raw: null, hash: null, entries: [], playbookFiles: [] }
    }
    out.levels[level] = l
    out.rules.push(...l.rules)
    out.problems.push(...l.problems.map((p) => `${level}: ${p}`))
    if (l.hint) out.hints.push({ level, folder, text: l.hint })
  }
  return out
}

/** A rule in one line for the panel and the CLI: its sources, conditions, Jev, playbook, model and limits. */
function summaryOf(rule) {
  const parts = [rule.sources.includes(S.ANY_SOURCE) ? 'any source' : rule.sources.join(' or ')]
  if (rule.when.length) parts.push(rule.when.map(conditionText).join(' and '))
  else if (!rule.jev) parts.push('every new item')
  if (rule.jev) parts.push(`Jev ≥ ${rule.jev.min}`)
  if (rule.hours) parts.push(`hours ${S.hoursLabel(rule.hours)}`)
  const lim = `${rule.limits.perDay}/day${rule.limits.cooldownMinutes ? `, ${rule.limits.cooldownMinutes} min cooldown` : ''}${rule.onChange ? ', again on change' : ''}`
  const run = [rule.model, rule.effort].filter(Boolean).join(' ')
  return `${parts.join(', ')} · playbook ${rule.playbook}${run ? ` (${run})` : ''} · ${lim}`
}

module.exports = {
  DEFAULT_GLOBAL_FOLDER,
  V1_HINT,
  RULES_FILE,
  V1_RULES_FILE,
  PLAYBOOKS_DIR,
  MAX_RULES,
  MAX_RULES_BYTES,
  MAX_PLAYBOOK_BYTES,
  LIMIT_DEFAULTS,
  JEV_MIN_DEFAULT,
  RULE_ID,
  PLAYBOOK_NAME,
  readRules,
  hashText,
  parsePlaybook,
  expandFolder,
  levelFolder,
  displayPath,
  loadFolder,
  loadLevels,
  summaryOf,
}
