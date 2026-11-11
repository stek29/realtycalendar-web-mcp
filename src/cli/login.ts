// login / logout (testing.md): a separate RC session for the MCP. The password is never stored or logged.
import { createInterface } from 'node:readline'
import { ToolError } from '../domain/errors.js'
import { signIn, signOut } from '../upstream/api.js'
import { RcClient } from '../upstream/client.js'

export interface LoginIo {
  /** Asks on stderr; `hidden` doesn't echo what is typed. */
  ask(question: string, hidden?: boolean): Promise<string>
  /** stdout: only the token goes here. */
  out(s: string): void
  /** stderr: everything else. */
  err(s: string): void
  /** Releases stdin when done. */
  close?(): void
}

interface Opts {
  baseUrl: string
  userAgent: string
  fetch?: typeof fetch
}

/** Asks for username and password, signs in, prints the token. Returns the exit code. */
export async function login(io: LoginIo, opts: Opts): Promise<number> {
  const username = (await io.ask('RealtyCalendar login (e-mail or phone): ')).trim()
  const password = await io.ask('Password: ', true)
  io.close?.()
  if (!username || !password) {
    io.err('Login and password are required.')
    return 1
  }
  try {
    const { auth_token } = await signIn(new RcClient('', opts), username, password)
    io.err('Signed in. Put this token into RC_TOKEN (it is a separate session; `logout` ends it):')
    io.out(auth_token)
    return 0
  } catch (e) {
    io.err(
      e instanceof ToolError && (e.code === 'AUTH' || e.code === 'VALIDATION')
        ? 'Sign-in refused: check the login and password.'
        : `Sign-in failed: ${e instanceof ToolError ? `${e.code}: ${e.message}` : String(e)}`,
    )
    return 1
  }
}

/** Ends the RC session of RC_TOKEN (only that one). Returns the exit code. */
export async function logout(token: string | undefined, err: (s: string) => void, opts: Opts): Promise<number> {
  if (!token) {
    err('RC_TOKEN is not set.')
    return 1
  }
  try {
    await signOut(new RcClient(token, opts))
    err('Signed out: this token no longer works.')
    return 0
  } catch (e) {
    if (e instanceof ToolError && e.code === 'AUTH') {
      err('The token was already invalid.')
      return 0
    }
    err(`Sign-out failed: ${e instanceof ToolError ? `${e.code}: ${e.message}` : String(e)}`)
    return 1
  }
}

/**
 * Prompts on stderr; hidden input is not echoed on a terminal. One readline with a line queue, so piped input
 * (`printf 'login\npassword\n' | … login`) works too: lines that arrive before their question are kept.
 */
export function terminalIo(): LoginIo {
  const tty = process.stdin.isTTY === true
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: tty })
  const rlOut = rl as unknown as { _writeToOutput(s: string): void }
  const write = rlOut._writeToOutput.bind(rl)
  let muted = false
  rlOut._writeToOutput = (s) => (muted ? undefined : write(s))
  const lines: string[] = []
  const waiting: ((line: string) => void)[] = []
  let closed = false
  rl.on('line', (line) => (waiting.length ? waiting.shift()!(line) : lines.push(line)))
  rl.on('close', () => {
    closed = true
    waiting.splice(0).forEach((w) => w(''))
  })
  return {
    ask(question, hidden = false) {
      process.stderr.write(question)
      muted = hidden && tty
      return new Promise((resolve) => {
        const answer = (line: string) => {
          if (muted) process.stderr.write('\n')
          muted = false
          resolve(line)
        }
        const line = lines.shift()
        if (line !== undefined) answer(line)
        else if (closed) answer('')
        else waiting.push(answer)
      })
    },
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    close: () => rl.close(),
  }
}
