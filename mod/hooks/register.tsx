// The signposts plugin's hooks module, for Claude Code builds that load mods.
// It does what the rest of the plugin does through a settings file, a forked
// skill and rows in the transcript, and does it in-engine, beside the
// conversation rather than inside it:
//
//   - the pane: one docked pane holds the status, the offer with a Run
//     button, the run's progress and outcome, and what each search found.
//     Claude Code opens a pane by itself only from 144 columns, so below that
//     the band above the prompt carries the offer and `$.ui.status` the row,
//     as they did before the pane, and `/signposts-pane` opens it at any width.
//   - the transcript: the hook prints no `systemMessage` under the mod, and
//     while the pane is up the `search_signposts` call draws no row either.
//     Its claims go to the pane, which a `tool.call` hook feeds.
//   - the run: `$.model.complete` answers each halt, and the replies go to
//     `signpost resume --replies -` on stdin, so no subagent, no replies file
//     and no permission prompt (skills/signposts/SKILL.md is the other route).
//
// The rest of the plugin stays for builds without mods. This module sets
// SIGNPOSTS_MOD in the process before the SessionStart command hook runs, and
// the hook and the statusLine, which inherit it, leave all of the above to this
// module (hooks/session-start.ts, statusline/statusline.ts).
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

import type { SignpostsPhase, SignpostsSearch } from '../types'

const eligible = atom({ plugin: 'signposts-mod', key: 'eligible' } as const, 0)
const phase = atom({ plugin: 'signposts-mod', key: 'phase' } as const, 'idle' as SignpostsPhase)
const detail = atom({ plugin: 'signposts-mod', key: 'detail' } as const, '')
const isDismissed = atom({ plugin: 'signposts-mod', key: 'isDismissed' } as const, false)
const row = atom({ plugin: 'signposts-mod', key: 'row' } as const, '')
const searches = atom({ plugin: 'signposts-mod', key: 'searches' } as const, [] as SignpostsSearch[])
const isPanePlaced = atom({ plugin: 'signposts-mod', key: 'isPanePlaced' } as const, false)
const manualCommand = atom({ plugin: 'signposts-mod', key: 'manualCommand' } as const, '')
/** Under personal storage, what the gate flagged: no pull request carries it, so the pane does. */
const flagged = atom({ plugin: 'signposts-mod', key: 'flagged' } as const, [] as string[])

// The band and the toast carry the name. The status row does not: Claude Code
// draws a plugin's status as `<plugin>: <text>` already.
const PREFIX = '🪧 signposts: '
const PANE = 'signposts'
const COMMAND = 'signposts-pane'
/** The MCP tool as Claude Code names it: the plugin, its server, the tool (.claude-plugin/plugin.json). */
const SEARCH_TOOL = 'mcp__plugin_signposts_signposts__search_signposts'
const MAX_SEARCHES = 5
const REFRESH_MS = 5_000
/** One `signpost` invocation can load the embedder and run the graph; ten minutes is the most `$.process.run` allows. */
const CLI_TIMEOUT_MS = 600_000
const REPLY_MAX_TOKENS = 32_000

// 13-constants.md, transcribed as statusline/statusline.ts does.
const MS_PER_MINUTE = 60_000
const RUN_PROGRESS_STALE_MS = 15 * MS_PER_MINUTE
const CENSUS_STALE_MS = 24 * 60 * MS_PER_MINUTE
const REPO_HASH_LENGTH = 12
// Personal storage, read as hooks/session-start.ts reads it: the variable,
// then one line of the user's config (src/core/config/schema.ts is the authority).
const PERSONAL_STORAGE_LINE = /^storage:\s*["']?personal["']?\s*(#.*)?$/m

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
  /** src/graph/ports.ts's CommitOutcome; `store` is set under personal storage. */
  commit: { branch: string | null; pr: number | null; store?: string; flagged?: string[] } | null
  reason?: string
}
/** src/cli/run-port.ts; `reason` says why there is no pull request, or why it is stale. */
type PublishOutcome = { url: string | null; pr: number | null; reason: string | null; manualCommand: string | null }
type PublishOutput = { status: 'published' | 'nothing'; publish: PublishOutcome | null }

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

/** statusline/statusline.ts's `statusLine`, same rows in the same order, without its prefix. */
export function statusLine(status: Status, nowMs: number): string {
  const progress = status.runProgress
  if (progress !== undefined && isFresh(progress.updatedAt, nowMs, RUN_PROGRESS_STALE_MS)) {
    const done = whole(progress.sessionsDone)
    return `${done}/${Math.max(done, whole(progress.sessionsTotal))} sessions · ${whole(progress.found)} found`
  }
  const unpublished = whole(status.unpublishedSessions)
  if (unpublished > 0) return `${plural(unpublished, 'session')} not published — run \`signpost publish\``
  if (status.phase === 'running' && isFresh(status.updatedAt, nowMs, RUN_PROGRESS_STALE_MS)) return 'indexing'
  if (typeof status.lastError === 'string' && status.lastError !== '') return 'last run failed — run `signpost doctor`'
  const count = whole(status.eligibleSessions)
  if (count > 0 && isFresh(status.updatedAt, nowMs, CENSUS_STALE_MS)) return `${plural(count, 'session')} not yet captured`
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

/** The offer, saying where a run's findings go. */
export function offerLine(count: number, isPersonal: boolean): string {
  const goesTo = isPersonal ? 'A run saves what it finds on this machine.' : 'A run opens a pull request with what it finds.'
  return `${plural(count, 'session')} ready to distil. ${goesTo}`
}

/** The run's last line: what it proposed, and where it went or why it went nowhere. */
export function outcomeLine(
  found: number,
  sessions: number,
  outcome: PublishOutcome | null,
  store?: string,
  heldCount = 0,
): string {
  if (found === 0) return `${plural(sessions, 'session')} read, nothing proposed`
  if (store !== undefined) {
    const held = heldCount === 0 ? '' : `. ${heldCount} to look at closely, listed in the signposts pane (/signposts-pane)`
    return `${plural(found, 'change')} saved in ${store}${held}`
  }
  const where = outcome?.url ?? (outcome?.pr == null ? null : `PR #${outcome.pr}`)
  if (outcome?.reason == null) return `${plural(found, 'change')} proposed${where === null ? '' : ` — ${where}`}`
  const finish = outcome.manualCommand === null ? '' : '. The command to finish it is in the signposts pane (/signposts-pane)'
  return `${plural(found, 'change')} committed${where === null ? '' : ` on ${where}`}, but ${outcome.reason}${finish}`
}

/**
 * The claims a `search_signposts` call returned (src/core/mcp/search-tool.ts),
 * or none. The result is the MCP tool's, so its `structuredContent` is looked
 * for as well as the output itself, and a string is parsed.
 */
export function claimsIn(result: unknown): SignpostsSearch['claims'] {
  let value = result
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (value === null || typeof value !== 'object') return []
  const { results, structuredContent } = value as { results?: unknown; structuredContent?: unknown }
  if (!Array.isArray(results)) return structuredContent === undefined ? [] : claimsIn(structuredContent)
  return results.map((hit: { claim?: unknown; category?: unknown }) => ({
    claim: String(hit.claim),
    category: typeof hit.category === 'string' ? hit.category : '',
  }))
}

/** A tool group that holds the search and nothing the person would miss: the ToolSearch that loaded it. */
export function isSearchOnly(tools: readonly string[]): boolean {
  return tools.includes(SEARCH_TOOL) && tools.every(tool => tool === SEARCH_TOOL || tool === 'ToolSearch')
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
let isPersonal = false

async function readIsPersonal($: EngineInterface, home: string): Promise<boolean> {
  const fromEnv = await $.env.get('SIGNPOSTS_STORAGE')
  if (fromEnv !== undefined) return fromEnv === 'personal'
  try {
    return PERSONAL_STORAGE_LINE.test(await $.fs.read(`${home}/.signposts/config.yaml`))
  } catch {
    return false
  }
}

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

async function openPane($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: 'signposts' })
  await update($, isPanePlaced, () => opened.isPlaced)
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
  if (line !== (await read($, row))) await update($, row, () => line)
  const count = whole(status.eligibleSessions)
  if (count !== (await read($, eligible))) await update($, eligible, () => count)
  // A widened terminal places a waiting pane and raises no event for it.
  const placed = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
  if (placed !== (await read($, isPanePlaced))) await update($, isPanePlaced, () => placed)
  $.ui.status(placed || line === '' ? undefined : line)
}

// Pressed, not awaited: a press hook has ten seconds, and a run takes minutes.
async function runAll($: EngineInterface): Promise<void> {
  if ((await read($, phase)) === 'running') return
  await update($, phase, () => 'running')
  await update($, manualCommand, () => '')
  await update($, flagged, () => [])
  try {
    const model = await $.session.model()
    const { sessions } = (await signpost($, ['sessions'])) as { sessions: { sessionId: string }[] }
    let found = 0
    let store: string | undefined
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
      store = out.commit?.store ?? store
      const held = out.commit?.flagged ?? []
      if (held.length > 0) await update($, flagged, list => [...list, ...held])
    }
    // A personal store is committed to as the run goes; there is nothing to push.
    const published = found === 0 || store !== undefined ? null : ((await signpost($, ['publish'])) as PublishOutput)
    await update($, manualCommand, () => published?.publish?.manualCommand ?? '')
    const heldCount = (await read($, flagged)).length
    await update($, detail, () => outcomeLine(found, sessions.length, published?.publish ?? null, store, heldCount))
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
      isPersonal = await readIsPersonal($, home)
      await $.command.register({ name: COMMAND, description: 'Show the signposts pane' })
      await openPane($)
      await refresh($)
      $.clock.every(REFRESH_MS, () => void refresh($))
    }
    return next(e)
  })

  // Asked, a pane is placed at any width; this is the way back after closing it.
  on('command.run', { command: COMMAND }, async $ => {
    await openPane($)
    await refresh($)
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, isPanePlaced, () => false)
      const line = await read($, row)
      $.ui.status(line === '' ? undefined : line)
    }
    return next(e)
  })

  on('tool.call', { tool: SEARCH_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    const claims = 'result' in ran ? claimsIn(ran.result) : []
    if (claims.length > 0) {
      const query = String((e as { query?: unknown }).query ?? '')
      await update($, searches, list => [{ query, claims }, ...list].slice(0, MAX_SEARCHES))
    }
    return ran
  })

  // While the pane is up the search draws there and nowhere in the transcript.
  // Claude Code folds an MCP call into a group line ("Called <server>"), after
  // the ToolSearch that loads the deferred tool, which the line leaves out. A
  // group with any other call in it keeps its line, since a rewrite of `calls`
  // changes nothing on screen. Unfolded (--verbose, ctrl+o) each is a ToolUse.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) =>
    (await read($, isPanePlaced)) && isSearchOnly(e.props.calls.map(call => call.tool)) ? <></> : next(e),
  )
  on('ui.render', { component: 'ToolUse', props: { tool: SEARCH_TOOL } }, async ($, e, next) =>
    (await read($, isPanePlaced)) ? <></> : next(e),
  )
  on('ui.render', { component: 'ToolResult', props: { tool: SEARCH_TOOL } }, async ($, e, next) =>
    (await read($, isPanePlaced)) ? <></> : next(e),
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, phase)
    const count = await read($, eligible)
    const line = await read($, row)
    const command = await read($, manualCommand)
    const found = await read($, searches)
    const held = await read($, flagged)
    const isOffer = current === 'idle' && count > 0 && !(await read($, isDismissed))
    // The offer says the backlog in its own words.
    const isRowShown = line !== '' && !(isOffer && line === statusLine({ eligibleSessions: count, updatedAt: new Date().toISOString() }, Date.now()))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {isRowShown && <Text>{line}</Text>}
          {isOffer && <Text>{offerLine(count, isPersonal)}</Text>}
          {isOffer && (
            <Box>
              <Button key="run" label="Run" variant="primary" onPress={() => void runAll($)} />
              <Button key="dismiss" label="Not now" onPress={() => update($, isDismissed, () => true)} />
            </Box>
          )}
          {current === 'running' && <Text dimColor>Running in the background, {await read($, detail)}</Text>}
          {(current === 'done' || current === 'failed') && (
            <Text color={current === 'failed' ? 'error' : undefined}>{await read($, detail)}</Text>
          )}
          {command !== '' && <Text dimColor>To finish by hand: {command}</Text>}
        </Box>
        {held.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Look closely at</Text>
            {held.map(line => (
              <Text>· {line}</Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column">
          <Text bold>Searches</Text>
          {found.length === 0 && <Text dimColor>Nothing found by a search in this session yet.</Text>}
          {found.map((search, index) => (
            <Box key={`search-${index}`} flexDirection="column">
              <Text dimColor>{search.query}</Text>
              {search.claims.map(hit => (
                <Text>
                  · {hit.claim}
                  {hit.category === '' ? '' : <Text dimColor> ({hit.category})</Text>}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })

  // The pane's fallback: on a terminal too narrow for it, or after it is closed.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (await read($, isPanePlaced)) return next(e)
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
          {offerLine(count, isPersonal)}{' '}
        </Text>
        <Button key="run" label="Run" variant="primary" onPress={() => void runAll($)} />
        <Button key="dismiss" label="Not now" onPress={() => update($, isDismissed, () => true)} />
      </Box>
    )
  })
}
