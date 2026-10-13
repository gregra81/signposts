// The signposts plugin's hooks module, for Claude Code builds that load mods.
// It does three things the rest of the plugin does through a settings file and
// a forked skill, and does them in-engine:
//
//   - the status line: `$.ui.status` pins a row of its own beside the
//     developer's statusLine, the same rows statusline/statusline.ts prints.
//   - the offer: a band above the prompt with a Run button, in place of the
//     `additionalContext` instruction that makes Claude stop and ask.
//   - the run: `$.model.complete` answers each halt, and the replies go to
//     `signpost resume --replies -` on stdin, so no subagent, no replies file
//     and no permission prompt (skills/signposts/SKILL.md is the other route).
//
// The rest of the plugin stays for builds without mods. This module sets
// SIGNPOSTS_MOD in the process before the SessionStart command hook runs, and
// the hook and the statusLine, which inherit it, leave the offer and the row
// to this module (hooks/session-start.ts, statusline/statusline.ts).
//
// The CLI still does the work: SQLite, the ONNX embedder and the graph need
// Node, and a hooks module has none. It is on PATH because docs/install.sh put
// it there before it installed this plugin.
//
// `resolve` is answered like the other three nodes, with no tools, where the
// skill's subagent could read the repository first. `undecidable` holds the
// change for the reviewer, so a contradiction the model cannot settle from the
// prompt alone still lands in the pull request under "Look closely at".

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SignpostsPhase } from '../types'

const eligible = atom({ plugin: 'signposts-mod', key: 'eligible' } as const, 0)
const phase = atom({ plugin: 'signposts-mod', key: 'phase' } as const, 'idle' as SignpostsPhase)
const detail = atom({ plugin: 'signposts-mod', key: 'detail' } as const, '')
const isDismissed = atom({ plugin: 'signposts-mod', key: 'isDismissed' } as const, false)

const PREFIX = '🪧 signposts: '
const REFRESH_MS = 5_000
/** One `signpost` invocation can load the embedder and run the graph; ten minutes is the most `$.process.run` allows. */
const CLI_TIMEOUT_MS = 600_000
const REPLY_MAX_TOKENS = 32_000

// 13-constants.md, transcribed as statusline/statusline.ts does.
const MS_PER_MINUTE = 60_000
const RUN_PROGRESS_STALE_MS = 15 * MS_PER_MINUTE
const CENSUS_STALE_MS = 24 * 60 * MS_PER_MINUTE
const REPO_HASH_LENGTH = 12

type Status = {
  phase?: string
  updatedAt?: string
  eligibleSessions?: number
  lastError?: string
  unpublishedSessions?: number
  runProgress?: { sessionsDone?: number; sessionsTotal?: number; found?: number; updatedAt?: string }
}

type ModelRequest = { node: string; system: string; user: string; schema: unknown }
type RunOutput = {
  sessionId: string
  contentHash: string
  status: 'waiting' | 'finished' | 'skipped'
  pending: { id: string; request: ModelRequest }[]
  proposed: string[]
  commit: unknown
  reason?: string
}
type PublishOutput = { status: 'published' | 'nothing'; publish: { url: string | null; pr: number | null; manualCommand: string | null } | null }

function whole(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function isFresh(stampedAt: unknown, nowMs: number, windowMs: number): boolean {
  const stamped = typeof stampedAt === 'string' ? Date.parse(stampedAt) : NaN
  return !Number.isNaN(stamped) && nowMs - stamped < windowMs
}

/** statusline/statusline.ts's `statusLine`, same rows in the same order. */
export function statusLine(status: Status, nowMs: number): string {
  const progress = status.runProgress
  if (progress !== undefined && isFresh(progress.updatedAt, nowMs, RUN_PROGRESS_STALE_MS)) {
    const done = whole(progress.sessionsDone)
    return `${PREFIX}${done}/${Math.max(done, whole(progress.sessionsTotal))} sessions · ${whole(progress.found)} found`
  }
  const unpublished = whole(status.unpublishedSessions)
  if (unpublished > 0) return `${PREFIX}${plural(unpublished, 'session')} not published — run \`signpost publish\``
  if (status.phase === 'running' && isFresh(status.updatedAt, nowMs, RUN_PROGRESS_STALE_MS)) return `${PREFIX}indexing`
  if (typeof status.lastError === 'string' && status.lastError !== '') return `${PREFIX}last run failed — run \`signpost doctor\``
  const count = whole(status.eligibleSessions)
  if (count > 0 && isFresh(status.updatedAt, nowMs, CENSUS_STALE_MS)) return `${PREFIX}${plural(count, 'session')} not yet captured`
  return ''
}

/** The replies the graph validates with zod (src/graph/llm.ts); a fenced or prefaced reply is cut down to its JSON. */
export function parseReply(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = (fenced?.[1] ?? text).trim()
  const start = body.search(/[[{]/)
  return JSON.parse(start <= 0 ? body : body.slice(start))
}

export function promptFor(request: ModelRequest): string {
  return (
    `${request.user}\n\n` +
    'Reply with one JSON value that satisfies this JSON Schema exactly. No prose, no code fence.\n' +
    JSON.stringify(request.schema)
  )
}

async function hashRepoRoot(repoRoot: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(repoRoot))
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, REPO_HASH_LENGTH)
}

// Set at session.start; a reload runs it again.
let repoRoot: string | null = null
let statusPath: string | null = null

async function signpost($: EngineInterface, args: string[], stdin?: string): Promise<unknown> {
  const result = await $.process.run(['signpost', ...args], {
    cwd: repoRoot ?? undefined,
    timeoutMs: CLI_TIMEOUT_MS,
    ...(stdin === undefined ? {} : { stdin }),
  })
  // Only 1 is a failure (SKILL.md); publish's 4 is work committed and not yet in a PR.
  if (result.exitCode === 1) throw new Error(`signpost ${args[0]}: ${result.stderr.trim().split('\n').pop() ?? ''}`)
  return JSON.parse(result.stdout)
}

async function answer($: EngineInterface, model: string, request: ModelRequest): Promise<unknown> {
  const reply = await $.model.complete({
    model,
    system: request.system,
    prompt: promptFor(request),
    maxTokens: REPLY_MAX_TOKENS,
  })
  if (!reply.isAnswered) throw new Error(`${request.node}: the model did not answer (${reply.reason})`)
  return parseReply(reply.text)
}

async function refresh($: EngineInterface): Promise<void> {
  if (statusPath === null) return
  let status: Status = {}
  try {
    status = JSON.parse(await $.fs.read(statusPath)) as Status
  } catch {
    // No status.json yet: nothing has run here and no worker has counted.
  }
  const line = statusLine(status, await $.clock.now())
  $.ui.status(line === '' ? undefined : line)
  const count = whole(status.eligibleSessions)
  if (count !== (await read($, eligible))) await update($, eligible, () => count)
}

async function runAll($: EngineInterface): Promise<void> {
  if ((await read($, phase)) === 'running') return
  await update($, phase, () => 'running')
  try {
    const model = await $.session.model()
    const { sessions } = (await signpost($, ['sessions'])) as { sessions: { sessionId: string }[] }
    let found = 0
    for (const [index, { sessionId }] of sessions.entries()) {
      await update($, detail, () => `session ${index + 1}/${sessions.length}`)
      let out = (await signpost($, ['run', '--session', sessionId, ...(index === 0 ? ['--first'] : [])])) as RunOutput
      while (out.status === 'waiting') {
        const answers = await Promise.all(out.pending.map(async p => [p.id, await answer($, model, p.request)] as const))
        out = (await signpost(
          $,
          ['resume', '--session', sessionId, '--content-hash', out.contentHash, '--replies', '-'],
          JSON.stringify({ replies: Object.fromEntries(answers) }),
        )) as RunOutput
        await refresh($)
      }
      found += out.proposed.length
    }
    const published = found === 0 ? null : ((await signpost($, ['publish'])) as PublishOutput)
    const where = published?.publish?.url ?? (published?.publish?.pr == null ? null : `PR #${published.publish.pr}`)
    await update($, detail, () =>
      found === 0
        ? `${plural(sessions.length, 'session')} read, nothing proposed`
        : `${plural(found, 'change')} proposed${where === null ? '' : ` — ${where}`}`,
    )
    await update($, phase, () => 'done')
  } catch (error) {
    await update($, detail, () => (error instanceof Error ? error.message : String(error)))
    await update($, phase, () => 'failed')
  }
  $.ui.toast(`${PREFIX}${await read($, detail)}`)
  await refresh($)
}

export const register: Register = on => {
  // Above every settings hook in the chain, so the command hook sees it set.
  on('classic.SessionStart', async ($, e, next) => {
    await $.env.set('SIGNPOSTS_MOD', '1')
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    // Set here too, so the statusLine does not depend on which event fires first.
    await $.env.set('SIGNPOSTS_MOD', '1')
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
    const home = await $.env.get('HOME')
    if (top.exitCode === 0 && home !== undefined) {
      // Resolved, as the hook does: the CLI keys STATE_DIR on its realpath'd cwd.
      repoRoot = (await $.fs.stat(top.stdout.trim(), { resolve: true })).realPath ?? top.stdout.trim()
      statusPath = `${home}/.signposts/${await hashRepoRoot(repoRoot)}/status.json`
      await refresh($)
      $.clock.every(REFRESH_MS, () => void refresh($))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, phase)
    const count = await read($, eligible)
    const isOffer = current === 'idle' && count > 0 && !(await read($, isDismissed))
    if (e.props.hasSurvey || (!isOffer && current !== 'running')) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    if (current === 'running') {
      return (
        <Box>
          <Text dimColor>
            {PREFIX}running in the background, {await read($, detail)}
          </Text>
        </Box>
      )
    }
    return (
      <Box>
        <Text>
          {PREFIX}
          {plural(count, 'session')} ready to distil. A run opens a pull request with what it finds.{' '}
        </Text>
        <Button key="run" label="Run" variant="primary" onPress={() => runAll($)} />
        <Button key="dismiss" label="Not now" onPress={() => update($, isDismissed, () => true)} />
      </Box>
    )
  })
}
