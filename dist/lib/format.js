'use strict'
// `ccc autopilot format` (the rule and playbook format, for a person or a Claude session writing
// rules) and the prompt of the panel's "Ask Claude to write a rule". The format text is built from
// lib/schema.js, the constants the loader checks with, and test/format.test.js checks that every key
// the loader knows is in it and that its example is a valid rule: the two cannot drift.

const S = require('./schema')
const C = require('./conditions')

const kib = (n) => `${n / 1024} KiB`
const range = (k) => `${S.LIMITS[k].min}-${S.LIMITS[k].max}`

/**
 * Every key of a rule, in file order: `[key, type, what]`. test/format.test.js checks it lists
 * exactly RULE_KEYS, `jev.` + JEV_KEYS, `hours.` + HOURS_KEYS and `limits.` + LIMIT_KEYS.
 */
const FIELDS = [
  ['id', 'string, required', `1-64 letters, digits, ".", "_" or "-", starting with a letter or digit; unique in its level's file (the log and the CLI name it <level>:<id>, project:site-down)`],
  ['name', 'string', `a label for people, at most ${S.MAX_NAME} characters; shown in the panel and the log`],
  ['enabled', 'true | false', 'default true; a rule that is off never fires (the dry run still shows it)'],
  ['sources', 'list of strings, required', `the plugin ids whose items the rule looks at ("bronos.chat"), 1-${S.MAX_SOURCES} of them, or exactly ["${S.ANY_SOURCE}"] for any source. There is no default: a rule written with Chat in mind must not fire on incoming email by omission, since anyone outside can send mail. An id with no running feed is kept ("no such source here")`],
  ['when', 'list of conditions', `0-${S.MAX_WHEN} field conditions, all must hold (the table below). Empty or left out is allowed: with a jev it is the Jev question alone, without one every new item of the sources starts a session (limits still apply)`],
  ['jev', 'object', 'one yes/no question for Jev, asked only for items that pass sources, hours and when'],
  ['jev.question', 'string', `the yes/no question Jev answers about the item's title and preview; 1-${S.MAX_QUESTION} characters`],
  ['jev.min', 'number 0..1', `the rule holds when Jev's yes is at or above this; default ${S.JEV_MIN_DEFAULT}`],
  ['hours', 'object', 'active hours, local time of the machine Autopilot runs on: { "from": "22:00", "to": "07:00" }; "HH:MM" 24-hour; from is inclusive, to is exclusive; to before from crosses midnight (22:00 to 07:00 is the night); the same time twice is an error. Outside them the rule does not fire and the item is not queued for later; left out: any time'],
  ['hours.from', 'string "HH:MM"', 'start of the window, inclusive'],
  ['hours.to', 'string "HH:MM"', 'end of the window, exclusive'],
  ['playbook', 'string', "a session rule: the playbook file playbooks/<name>.md of the rule's own level (a global rule never reads a project's playbooks/), named without \".md\". A rule has playbook or act, never both"],
  ['act', 'string', `an act rule: one of the item's own actions that Autopilot runs itself, with no Claude session (markRead, markUnread, done, or an id the source offers); only on new items, and only when the item offers it then (else the next rule may take the item). Not ${S.ACT_REFUSED.map((a) => `"${a}"`).join(', ')}. An act rule has none of ${S.SESSION_KEYS.join(', ')}`],
  ['mode', S.MODE_LIST.join(' | '), `a session rule: ${S.MODE_DEFAULT} (the default) changes nothing; act may carry out only the actions its playbook lists under a "${S.ALLOWED_ACTIONS}" heading, on that item only (a playbook without that list makes the rule a problem)`],
  ['check', 'string', `a session rule, at most ${S.MAX_CHECK} characters: what the session checks first against the full item (it may name what only the item shows, a screenshot too); when it does not hold, the session says so in one line and stops. Left out: no check`],
  ['model', `${S.MODEL_LIST.join(' | ')}`, "a session rule: the session's model; left out: your default. Needs cc-cockpit 0.11, older apps ignore it"],
  ['effort', `${S.EFFORT_LIST.join(' | ')}`, "a session rule: the session's effort; left out: your default. Needs cc-cockpit 0.11, older apps ignore it"],
  ['onChange', 'true | false', 'a session rule: default false (a rule fires once per item); true sends a newer version of the item (a reply, a comment, a status change) to the same session'],
  ['limits', 'object', 'per rule'],
  ['limits.perDay', 'whole number', `${range('perDay')} sessions (an act rule: actions that succeeded) in a rolling 24 hours; default ${S.LIMITS.perDay.default}, an act rule's ${S.LIMITS.perDay.actDefault}`],
  ['limits.cooldownMinutes', 'whole number', `${range('cooldownMinutes')} minutes between two sessions (actions) of this rule, 0 is no cooldown; default ${S.LIMITS.cooldownMinutes.default}, an act rule's ${S.LIMITS.cooldownMinutes.actDefault}`],
]

/** The condition table, from conditions.js: `field  ops  value`. */
const conditionRows = () =>
  Object.entries(C.FIELDS).map(([field, { ops, value }]) => {
    const what = {
      text: `text, 1-${C.MAX_VALUE} characters`,
      kind: C.KINDS.join(' | '),
      to: C.TO.join(' | '),
      bool: 'true | false',
      read: 'true | false | null',
      minutes: `whole minutes, 1-${C.MAX_MINUTES}`,
    }[value]
    return [field, ops.join(' '), ops.includes('in') ? `${what}; for in: a list of 1-${C.MAX_IN} of them` : what]
  })

/** A rule that passes the loader (test/format.test.js checks it with readRules). Example data only. */
const EXAMPLE_RULE = Object.freeze({
  id: 'site-down',
  name: 'Site down',
  enabled: false,
  sources: ['bronos.chat'],
  when: [
    { field: 'place.name', op: 'is', value: 'Server Issues' },
    { field: 'mentionsMe', op: 'is', value: true },
    { field: 'title', op: 'contains', value: 'down' },
  ],
  jev: { question: 'Does this message report that a website is down right now?', min: 0.7 },
  hours: { from: '22:00', to: '07:00' },
  playbook: 'site-check',
  mode: 'investigate',
  check: 'The message reports that a website (such as shop.example.com) is down right now.',
  model: 'sonnet',
  effort: 'medium',
  onChange: false,
  limits: { perDay: 10, cooldownMinutes: 30 },
})

/** An act rule that passes the loader: marks notification mails of finished issues read, no session. Example data only. */
const EXAMPLE_ACT_RULE = Object.freeze({
  id: 'done-mails-read',
  name: 'Finished-issue mails read',
  enabled: false,
  sources: ['bronos.gmail'],
  when: [
    { field: 'from.address', op: 'is', value: 'tracker@example.com' },
    { field: 'title', op: 'contains', value: 'Done' },
  ],
  act: 'markRead',
})

/** The part an act-mode playbook needs (schema.js hasAllowedActions). Example data only. */
const EXAMPLE_ALLOWED = `## ${S.ALLOWED_ACTIONS}

- Append one line to ~/notes/site-incidents.md: the date, the hostname and the status code.
- Check the site once more after two minutes, with the same command.`

const EXAMPLE_PLAYBOOK = `# Check a website

The site to check is the hostname the item names: a plain public hostname (letters, digits, dots,
hyphens), never a URL from the item. Build \`https://<host>/\` yourself.

1. Fetch the page and note the status code and the response time.
2. ...

Report: up or down, what you saw, what you recommend.`

/** The text `ccc autopilot format` prints. */
function formatText() {
  const width = Math.max(...FIELDS.map(([k]) => k.length)) + 2
  const indent = ' '.repeat(width + 2)
  const wrap = (s) => {
    const out = []
    let line = ''
    for (const w of s.split(' ')) {
      if (line && line.length + w.length + 1 > 100 - width) {
        out.push(line)
        line = w
      } else line = line ? `${line} ${w}` : w
    }
    if (line) out.push(line)
    return out.join(`\n${indent}`)
  }
  const cw = Math.max(...conditionRows().map(([f]) => f.length)) + 2
  const condLines = conditionRows().map(([f, ops, v]) => `  ${f.padEnd(cw)}${ops}  (${v})`).join('\n')
  const fields = FIELDS.map(([k, type, what]) => `  ${k.padEnd(width)}${wrap(`${type}: ${what}`)}`).join('\n')
  return `Autopilot rule and playbook format (bronos.autopilot)

Two rule levels, each a folder of its own (\`ccc autopilot status\` prints both):
  project   the project setting "Project rules folder" (empty by default: no project rules; a relative path
            is read from the project folder). Its rules run in this project only.
  global    the app setting "Global rules folder" (default ~/.config/cc-cockpit-autopilot; empty: none).
            Its rules run in every project.
Project rules are checked first, then global ones; the first rule that holds wins. Each folder has:
  ${S.RULES_FILE.padEnd(22)}a JSON list, at most ${S.MAX_RULES} rules and ${kib(S.MAX_RULES_BYTES)}; no comments or trailing commas
  ${`${S.PLAYBOOKS_DIR}/<name>.md`.padEnd(22)}one Markdown playbook per file, at most ${kib(S.MAX_PLAYBOOK_BYTES)}

A rule (keys in this order):
${fields}

Conditions (the \`when\` list; the same format as the Inbox plugin's rules), each { "field", "op", "value" }:
${condLines}
Text compares case-insensitively; there are no regexes.

Order of checks for a rule: enabled, sources, hours, when, jev (cheapest first, so an item outside the
hours costs no Jev request). Rules are tried in order (the project file, then the global one) and the
first that holds is the item's rule. A rule with a bad value is a problem (shown in the panel and by
\`ccc autopilot reload\`) and is skipped; the others keep working. An unknown key is ignored with a warning.
v1's ${S.V1_RULES_FILE} is never read (v2 reads ${S.RULES_FILE}); a v1 entry copied into the new file is an
invalid rule (no \`sources\`). Porting one: \`match.source\` becomes \`sources\` (no source: ["${S.ANY_SOURCE}"]),
\`where\` becomes a \`place.name contains\` condition, \`from\` \`from.name contains\`, \`text\` \`title contains\`,
\`triage.jev\` becomes \`jev\`, \`condition\` becomes \`check\`, \`on\` becomes \`enabled\`; \`level\` has no
equivalent (use labels or a Jev question).

Example ${S.RULES_FILE}:
${JSON.stringify([EXAMPLE_RULE], null, 2)}

A playbook, ${S.PLAYBOOKS_DIR}/<name>.md:
  <name>: 1-64 letters, digits, "_" or "-", starting with a letter or digit (no dot, no slash).
  Markdown you write: what the session checks, how, and what it reports. The model and effort are
  the rule's (model: ${S.MODEL_LIST.join(', ')}; effort: ${S.EFFORT_LIST.join(', ')}), not the
  playbook's: front matter in a playbook is ignored. Name the places the session may check itself
  (your hosts, projects), so it never has to take one from the item. Autopilot adds a fixed frame
  before it: the item fenced and untrusted, the injection check, the rule's check (when it has one)
  made first, and the permission of the rule's mode: investigate only, or (mode "act") only the
  actions listed under the playbook's "${S.ALLOWED_ACTIONS}" heading, on that item only.

Example ${S.PLAYBOOKS_DIR}/site-check.md:
${EXAMPLE_PLAYBOOK}

An act-mode playbook adds the list (each action with its exact target; a value from the item only where
the playbook says how):
${EXAMPLE_ALLOWED}

Three kinds of rule, from least to most power:
  act rule          "act": one of the item's own actions (mark read, done): no Claude, so no outside
                    text reaches a model. Use it whenever that one action is the whole job.
  mode investigate  a session that looks and reports; it changes nothing (the default).
  mode act          a session that may also carry out the playbook's listed actions. Claude Code's own
                    permission settings still apply inside the tab: anything they do not allow waits.

Example act rule (no playbook):
${JSON.stringify(EXAMPLE_ACT_RULE, null, 2)}

${S.BASE_FILE} (optional, in either level's folder, at most ${kib(S.MAX_BASE_BYTES)}): your standing instructions for
every Autopilot session (how to report, what never to touch). Its text goes into each session's prompt
after the fixed frame and before the item (global first, then project). It cannot remove or reorder the
frame. A ${S.BASE_FILE} that is there but cannot be read opens no session until it is fixed.

After an edit: \`ccc autopilot reload\` lists the problems; \`ccc autopilot test <id>\` is a dry run over
the items in the feeds now (it starts no session). Writes take --project or --global when both folders exist.
`
}

/**
 * The prompt of "Ask Claude to write a rule": the session learns the format from `ccc autopilot
 * format`, edits the files of the level the person picks (`folders`: `{ project, global }`, absolute
 * paths or null for a level with no folder), then reloads and dry-runs the rule. It starts with a
 * plain word: sessions.open refuses a prompt starting with "/", "!", "#" or "&".
 */
function askPrompt(folders) {
  const f = typeof folders === 'string' ? { project: null, global: folders } : folders || {}
  const where = S.LEVELS.filter((l) => f[l]).map((l) => `${l} rules in ${S.oneLine(f[l])}`)
  const text = [
    'Help me write an Autopilot rule and its playbook (the cc-cockpit plugin bronos.autopilot): when a new inbox item matches the rule, Autopilot opens a Claude session that investigates it with the playbook.',
    'First run `ccc autopilot format` to learn the rule and playbook format, and `ccc autopilot status` to see the rules I have now.',
    `My rules and playbooks are files in ${where.length ? where.join(' and ') : 'a rules folder that is not set yet (ask me which one)'}: each folder has ${S.RULES_FILE} (a JSON list of rules) and ${S.PLAYBOOKS_DIR}/<name>.md. Project rules run in this project only, global ones in every project${where.length > 1 ? '; ask me which level the rule belongs to' : ''}. Edit the files there; keep every other rule exactly as it is.`,
    'Ask me what should trigger the rule (which sources first, then space or project, which words) and what the session should check and report, one question at a time. Write the new rule with "enabled": false.',
    `When the files are written, run \`ccc autopilot reload\` and \`ccc autopilot test <id>\` with the new rule's id, and show me the result: the problems, if any, and which current items it would fire on and why. I switch the rule on myself.`,
  ].join('\n\n')
  if (/^[/!#&]/.test(text)) throw new Error('autopilot: the prompt may not start with a command character')
  return text
}

module.exports = { FIELDS, EXAMPLE_RULE, EXAMPLE_ACT_RULE, EXAMPLE_ALLOWED, EXAMPLE_PLAYBOOK, formatText, askPrompt }
