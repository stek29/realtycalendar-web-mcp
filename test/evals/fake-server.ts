// The real MCP server over stdio with the fake RC (plan-m3.md §1). One process per CLI turn; the fake's state lives in
// EVAL_STATE between turns. Env: EVAL_CASE, EVAL_STATE, EVAL_NOW, RC_ACCESS, RC_CONFIRM_KEY.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { memoryCache } from '../../src/cache.js'
import { parseConfig } from '../../src/config.js'
import { makeContext } from '../../src/context.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { fakeRc, type FakeState } from '../fake-rc.js'
import { scenarioState } from './scenario.js'

const file = process.env.EVAL_STATE
if (!file) throw new Error('EVAL_STATE is not set')
const state: FakeState =
  existsSync(file) && readFileSync(file, 'utf8').trim()
    ? JSON.parse(readFileSync(file, 'utf8'))
    : scenarioState(process.env.EVAL_CASE ?? '')
const save = () => writeFileSync(file, JSON.stringify(state))
save()

const rc = fakeRc({ state })
const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const res = await rc.fetch(input, init)
  if ((init?.method ?? 'GET') !== 'GET') save()
  return res
}) as typeof globalThis.fetch

const now = new Date(process.env.EVAL_NOW ?? '2054-10-22T09:00:00+03:00')
const ctx = makeContext('eval-token', parseConfig(process.env), memoryCache(), { fetch, now: () => now })
serveStdio(() => createMcpServer(ctx))
