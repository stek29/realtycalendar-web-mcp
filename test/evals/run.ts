// Eval harness (plan-m3.md §1): runs the spec §3 cases on headless clients against the fake-RC server, grades the tool
// calls and answers, prints a benchmark table and writes a report.
//   npm run evals -- [--runner claude-sonnet,codex,claude-haiku] [--case U5a,…] [--repeat 3] [--jobs 4]
// --live: the real server (dist/main.js) with RC_TOKEN and RC_ACCESS=read, read cases only, no transcripts (§2): the
// token stays in the environment (not in the client's config file) and the client keeps no session on disk.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const FAKE_SERVER = join(ROOT, 'test', 'evals', 'fake-server.ts')
const TURN_TIMEOUT_MS = 300_000
const WRITE_TOOLS = new Set(['create_booking', 'update_booking', 'cancel_booking', 'delete_booking'])
/** M1 read cases for the live client check (§2). */
const LIVE_CASES = [
  'U1a',
  'U1b',
  'U1c',
  'U2',
  'U3a',
  'U3b',
  'U3c',
  'U4a',
  'U4b',
  'U4c',
  'U9',
  'U10a',
  'U12a',
  'U12b',
  'U12c',
  'R1',
  'R2',
  'R3',
]

// ---- cases ----

type Matcher = unknown
interface ExpectedCall {
  tool: string
  args: Record<string, Matcher>
  confirm_token?: boolean
  count?: number
}
interface TurnExpect {
  calls: ExpectedCall[]
  answer?: string[]
  forbid?: string[]
}
interface Case {
  id: string
  access: string
  turns: string[]
  expect: TurnExpect[]
  forbid_token?: string[]
  forbid_args?: Record<string, string[]>
  /** Why the case can't run headless; it is left out. */
  skip?: string
}

// ---- runs ----

interface Call {
  tool: string
  args: Record<string, unknown>
  error: boolean
}
interface Turn {
  calls: Call[]
  answer: string
  cost_usd: number | null
  input_tokens: number
  output_tokens: number
  ms: number
  failed?: string
}
interface Run {
  runner: string
  case: string
  repeat: number
  turns: Turn[]
  pass: boolean
  failures: string[]
}

interface Server {
  command: string
  args: string[]
  env: Record<string, string>
}

interface Runner {
  name: string
  /** Runs one turn; `session` carries the client's conversation id between turns. */
  turn(
    prompt: string,
    s: { dir: string; server: Server; session?: string; live: boolean },
  ): Promise<{ turn: Turn; session?: string; raw: string }>
}

function exec(cmd: string, args: string[], cwd: string): Promise<{ out: string; code: number | null; ms: number }> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', () => {})
    const timer = setTimeout(() => child.kill('SIGKILL'), TURN_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ out, code, ms: Date.now() - started })
    })
  })
}

const jsonLines = (s: string) =>
  s.split('\n').flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l) as Record<string, any>] : [] // eslint-disable-line @typescript-eslint/no-explicit-any
    } catch {
      return []
    }
  })

function claude(name: string, model: string): Runner {
  return {
    name,
    async turn(prompt, { dir, server, session, live }) {
      const cfg = join(dir, 'mcp.json')
      writeFileSync(cfg, JSON.stringify({ mcpServers: { realtycalendar: server } }))
      const args = [
        '-p',
        prompt,
        '--model',
        model,
        '--strict-mcp-config',
        '--mcp-config',
        cfg,
        '--tools',
        '',
        '--allowedTools',
        'mcp__realtycalendar',
        '--setting-sources',
        'project',
        '--output-format',
        'stream-json',
        '--verbose',
        '--max-budget-usd',
        '1',
        ...(session ? ['--resume', session] : []),
        ...(live ? ['--no-session-persistence'] : []),
      ]
      const { out, ms, code } = await exec('claude', args, dir)
      const events = jsonLines(out)
      const calls: Call[] = []
      const byId = new Map<string, Call>()
      for (const e of events) {
        for (const b of e.type === 'assistant' || e.type === 'user' ? e.message.content : []) {
          if (b.type === 'tool_use') {
            const call = {
              tool: String(b.name).replace(/^mcp__realtycalendar__/, ''),
              args: b.input ?? {},
              error: false,
            }
            calls.push(call)
            byId.set(b.id, call)
          }
          if (b.type === 'tool_result' && b.is_error) byId.get(b.tool_use_id)!.error = true
        }
      }
      const result = events.find((e) => e.type === 'result')
      const u = result?.usage ?? {}
      return {
        session: result?.session_id ?? events.find((e) => e.type === 'system')?.session_id ?? session,
        raw: out,
        turn: {
          calls,
          answer: result?.result ?? '',
          cost_usd: result?.total_cost_usd ?? null,
          input_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          output_tokens: u.output_tokens ?? 0,
          ms,
          ...(result && !result.is_error ? {} : { failed: `claude exit ${code}: ${result?.subtype ?? 'no result'}` }),
        },
      }
    },
  }
}

function codex(model: string): Runner {
  const disable = ['shell_tool', 'unified_exec', 'plugins', 'apps', 'browser_use', 'in_app_browser', 'computer_use']
  const toml = (s: string) => JSON.stringify(s)
  return {
    name: 'codex',
    async turn(prompt, { dir, server, session }) {
      const mcp = [
        ['command', toml(server.command)],
        ['args', `[${server.args.map(toml).join(',')}]`],
        [
          'env',
          `{${Object.entries(server.env)
            .map(([k, v]) => `${k}=${toml(v)}`)
            .join(',')}}`,
        ],
        // Write tools aren't read-only, so exec would refuse them without approval.
        ['default_tools_approval_mode', '"approve"'],
      ].flatMap(([k, v]) => ['-c', `mcp_servers.realtycalendar.${k}=${v}`])
      const common = ['--json', '-m', model, '--skip-git-repo-check', '--ignore-user-config']
      const dis = disable.flatMap((d) => ['--disable', d])
      const args = session
        ? ['exec', 'resume', session, ...common, '-c', 'sandbox_mode="read-only"', ...dis, ...mcp, prompt]
        : ['exec', ...common, '-s', 'read-only', '-C', dir, ...dis, ...mcp, prompt]
      const { out, ms, code } = await exec('codex', args, dir)
      const events = jsonLines(out)
      const items = events.filter((e) => e.type === 'item.completed').map((e) => e.item)
      const usage = events.filter((e) => e.type === 'turn.completed').map((e) => e.usage)
      const messages = items.filter((i) => i.type === 'agent_message').map((i) => String(i.text ?? ''))
      return {
        session: events.find((e) => e.type === 'thread.started')?.thread_id ?? session,
        raw: out,
        turn: {
          calls: items
            .filter((i) => i.type === 'mcp_tool_call')
            .map((i) => ({
              tool: String(i.tool),
              args: (i.arguments ?? {}) as Record<string, unknown>,
              error: i.status !== 'completed' || i.error != null || i.result?.isError === true,
            })),
          answer: messages.at(-1) ?? '',
          cost_usd: null,
          input_tokens: usage.reduce((s, u) => s + (u.input_tokens ?? 0), 0),
          output_tokens: usage.reduce((s, u) => s + (u.output_tokens ?? 0), 0),
          ms,
          ...(usage.length ? {} : { failed: `codex exit ${code}: no turn.completed` }),
        },
      }
    },
  }
}

const RUNNERS: Record<string, Runner> = {
  'claude-sonnet': claude('claude-sonnet', 'claude-sonnet-5-5'),
  'claude-haiku': claude('claude-haiku', 'claude-haiku-5-5'),
  codex: codex('gpt-6.1-sol'),
}

// ---- grading ----

const regex = (s: string) => (s.startsWith('(?i)') ? new RegExp(s.slice(4), 'iu') : new RegExp(s, 'u'))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** Arguments without the token, keys sorted, for comparing a write with its preview. */
const plan = (args: Record<string, unknown>) =>
  JSON.stringify(
    Object.keys(args)
      .filter((k) => k !== 'confirm_token')
      .sort()
      .map((k) => [k, args[k]]),
  )

function valueMatches(m: Matcher, v: unknown): boolean {
  if (m && typeof m === 'object' && 're' in m)
    return v != null && regex(String((m as { re: string }).re)).test(String(v))
  if (m && typeof m === 'object' && 'oneOf' in m) {
    return (m as { oneOf: unknown[] }).oneOf.some((x) => (x === null ? v == null : same(x, v)))
  }
  return same(m, v)
}

function callMatches(e: ExpectedCall, c: Call): boolean {
  if (c.tool !== e.tool) return false
  if (!Object.entries(e.args).every(([k, m]) => valueMatches(m, c.args[k]))) return false
  const token = c.args.confirm_token != null && c.args.confirm_token !== ''
  if (e.confirm_token === false && token) return false
  // A confirm must also succeed.
  if (e.confirm_token === true && (!token || c.error)) return false
  return true
}

export function grade(c: Case, turns: Turn[]): string[] {
  const failures: string[] = []
  c.expect.forEach((exp, i) => {
    const t = turns[i]
    const at = `turn ${i + 1}`
    if (!t) return failures.push(`${at}: not run`)
    if (t.failed) failures.push(`${at}: ${t.failed}`)
    for (const e of exp.calls) {
      const n = t.calls.filter((call) => callMatches(e, call)).length
      if (n < (e.count ?? 1)) {
        failures.push(
          `${at}: expected ${e.count ?? 1}× ${e.tool}(${JSON.stringify(e.args)}${e.confirm_token == null ? '' : `, token=${e.confirm_token}`}), got ${n}`,
        )
      }
    }
    for (const call of t.calls) {
      if (exp.forbid?.includes(call.tool)) failures.push(`${at}: forbidden ${call.tool}`)
      const confirmed = WRITE_TOOLS.has(call.tool) && call.args.confirm_token
      if (confirmed && !exp.calls.some((e) => e.confirm_token === true && callMatches(e, call))) {
        failures.push(`${at}: unexpected confirmed ${call.tool}`)
      }
    }
    for (const re of exp.answer ?? []) if (!regex(re).test(t.answer)) failures.push(`${at}: answer lacks /${re}/`)
  })
  const all = turns.flatMap((t) => t.calls)
  all.forEach((call, i) => {
    // A write must follow a preview with the same arguments (D35).
    if (!WRITE_TOOLS.has(call.tool)) return
    const previewed = all.slice(0, i).some((p) => p.tool === `preview_${call.tool}` && plan(p.args) === plan(call.args))
    if (!previewed) failures.push(`${call.tool} without a preview with the same arguments`)
  })
  for (const call of all) {
    if (c.forbid_token?.includes(call.tool) && call.args.confirm_token)
      failures.push(`${call.tool} called with a token`)
    for (const a of c.forbid_args?.[call.tool] ?? []) if (a in call.args) failures.push(`${call.tool} got ${a}`)
  }
  return failures
}

// ---- main ----

function parseArgs(argv: string[]) {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const live = argv.includes('--live')
  return {
    live,
    runners: (get('runner') ?? (live ? 'claude-sonnet' : 'claude-sonnet,codex,claude-haiku')).split(','),
    cases: get('case')?.split(','),
    repeat: Number(get('repeat') ?? (live ? 1 : 3)),
    jobs: Number(get('jobs') ?? 4),
  }
}

async function pool<T>(items: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await items[i]!()
      }
    }),
  )
  return out
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const all = (JSON.parse(readFileSync(join(import.meta.dirname, 'cases.json'), 'utf8')) as { cases: Case[] }).cases
  const cases = all.filter(
    (c) => !c.skip && (opts.cases ? opts.cases.includes(c.id) : opts.live ? LIVE_CASES.includes(c.id) : true),
  )
  for (const c of all) if (c.skip) process.stderr.write(`skip ${c.id}: ${c.skip}\n`)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const reportDir = join(import.meta.dirname, 'reports')
  const transcripts = join(reportDir, stamp)
  if (opts.live && !process.env.RC_TOKEN) throw new Error('--live needs RC_TOKEN')
  // Codex keeps its sessions on disk; live runs are Claude-only.
  if (opts.live && opts.runners.some((r) => !r.startsWith('claude'))) throw new Error('--live runs Claude runners only')

  const jobs = opts.runners.flatMap((r) => {
    const runner = RUNNERS[r]
    if (!runner) throw new Error(`unknown runner ${r}`)
    return cases.flatMap((c) =>
      Array.from({ length: opts.repeat }, (_, k) => async (): Promise<Run> => {
        const dir = mkdtempSync(join(tmpdir(), 'rc-eval-'))
        const server: Server = opts.live
          ? {
              command: 'node',
              args: [join(ROOT, 'dist', 'main.js')],
              // RC_TOKEN comes from this process's environment, which the client passes on to the server.
              env: { RC_ACCESS: 'read' },
            }
          : {
              command: TSX,
              args: [FAKE_SERVER],
              env: {
                EVAL_CASE: c.id,
                EVAL_STATE: join(dir, 'state.json'),
                RC_ACCESS: c.access,
                RC_CONFIRM_KEY: 'eval',
              },
            }
        // An empty working directory per case run: no project files, settings or instructions for the client.
        const cwd = join(dir, 'cwd')
        mkdirSync(cwd)
        const turns: Turn[] = []
        let session: string | undefined
        for (const [i, prompt] of c.turns.entries()) {
          const r = await runner.turn(prompt, { dir: cwd, server, session, live: opts.live })
          session = r.session
          turns.push(r.turn)
          if (!opts.live) {
            mkdirSync(join(transcripts, runner.name), { recursive: true })
            writeFileSync(join(transcripts, runner.name, `${c.id}-${k + 1}-t${i + 1}.jsonl`), r.raw)
          }
          if (r.turn.failed) break
        }
        rmSync(dir, { recursive: true, force: true })
        const failures = grade(c, turns)
        if (opts.live) {
          // Live: only that no call failed; nothing about the data is kept.
          for (const [i, t] of turns.entries())
            if (t.calls.some((x) => x.error)) failures.push(`turn ${i + 1}: a tool call failed`)
        }
        const run = { runner: runner.name, case: c.id, repeat: k + 1, turns, pass: failures.length === 0, failures }
        process.stderr.write(
          `${run.pass ? 'ok  ' : 'FAIL'} ${run.runner} ${run.case}#${run.repeat}${run.pass ? '' : `: ${failures.join('; ')}`}\n`,
        )
        return opts.live
          ? {
              ...run,
              turns: turns.map((t) => ({
                ...t,
                answer: '',
                calls: t.calls.map((x) => ({ tool: x.tool, args: {}, error: x.error })),
              })),
            }
          : run
      }),
    )
  })
  const runs = await pool(jobs, opts.jobs)
  const summary = summarize(runs, cases, opts.repeat)
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(
    join(reportDir, `${stamp}${opts.live ? '-live' : ''}.json`),
    JSON.stringify({ opts, summary, runs }, null, 1),
  )
  printTable(summary)
  const gate = opts.live ? ['claude-sonnet'] : ['claude-sonnet', 'codex']
  const failed = summary.filter((s) => gate.includes(s.runner) && s.failed_cases.length)
  process.exitCode = failed.length ? 1 : 0
}

function summarize(runs: Run[], cases: Case[], repeat: number) {
  return [...new Set(runs.map((r) => r.runner))].map((runner) => {
    const mine = runs.filter((r) => r.runner === runner)
    const passed = (id: string) => mine.filter((r) => r.case === id && r.pass).length >= Math.ceil((repeat * 2) / 3)
    const groups = [...new Set(cases.map((c) => c.id[0]!))].map((g) => {
      const ids = cases.filter((c) => c.id[0] === g).map((c) => c.id)
      return { group: g, passed: ids.filter(passed).length, total: ids.length }
    })
    const turns = mine.flatMap((r) => r.turns)
    const expectedCalls = (id: string) =>
      cases.find((c) => c.id === id)!.expect.reduce((s, t) => s + t.calls.reduce((n, e) => n + (e.count ?? 1), 0), 0)
    const firstWrong = mine.filter((r) => {
      const exp = cases.find((c) => c.id === r.case)!.expect[0]?.calls[0]
      const first = r.turns[0]?.calls[0]
      return exp && first && first.tool !== exp.tool
    }).length
    const costs = turns.map((t) => t.cost_usd).filter((c): c is number => c != null)
    return {
      runner,
      passed_cases: cases.filter((c) => passed(c.id)).length,
      total_cases: cases.length,
      failed_cases: cases.filter((c) => !passed(c.id)).map((c) => c.id),
      groups,
      run_pass_rate: mine.filter((r) => r.pass).length / mine.length,
      calls_per_case: mean(mine.map((r) => r.turns.reduce((s, t) => s + t.calls.length, 0))),
      extra_calls_per_case: mean(
        mine.map((r) => r.turns.reduce((s, t) => s + t.calls.length, 0) - expectedCalls(r.case)),
      ),
      wrong_first_tool_rate: firstWrong / mine.length,
      input_tokens_per_turn: mean(turns.map((t) => t.input_tokens)),
      output_tokens_per_turn: mean(turns.map((t) => t.output_tokens)),
      cost_usd_total: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      seconds_per_turn: mean(turns.map((t) => t.ms / 1000)),
    }
  })
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

function printTable(summary: ReturnType<typeof summarize>) {
  const f = (n: number, d = 1) => n.toFixed(d)
  const rows = [
    [
      'runner',
      'cases',
      'runs',
      'groups',
      'calls/case',
      'extra',
      'wrong 1st',
      'in tok/turn',
      'out tok/turn',
      'cost $',
      's/turn',
    ],
    ...summary.map((s) => [
      s.runner,
      `${s.passed_cases}/${s.total_cases}`,
      `${f(s.run_pass_rate * 100, 0)}%`,
      s.groups.map((g) => `${g.group} ${g.passed}/${g.total}`).join(' '),
      f(s.calls_per_case),
      f(s.extra_calls_per_case),
      `${f(s.wrong_first_tool_rate * 100, 0)}%`,
      f(s.input_tokens_per_turn, 0),
      f(s.output_tokens_per_turn, 0),
      s.cost_usd_total == null ? '—' : f(s.cost_usd_total, 2),
      f(s.seconds_per_turn),
    ]),
  ]
  console.log(rows.map((r) => `| ${r.join(' | ')} |`).join('\n'))
  for (const s of summary) if (s.failed_cases.length) console.log(`${s.runner} failed: ${s.failed_cases.join(', ')}`)
}

if (process.argv[1] && import.meta.filename === process.argv[1]) await main()
