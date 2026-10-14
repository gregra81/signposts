import { expect, test } from 'claude-code/testing'

import { claimsIn, isSearchOnly, outcomeLine, parseReply, promptFor, statusLine } from '../hooks/register.tsx'

const NOW = Date.parse('2026-10-12T12:00:00.000Z')
const RECENT = '2026-10-12T11:58:00.000Z'
const LAST_WEEK = '2026-10-05T12:00:00.000Z'

test('status line: a run in flight outranks everything', async () => {
  const line = statusLine(
    { unpublishedSessions: 2, eligibleSessions: 4, updatedAt: RECENT, runProgress: { sessionsDone: 1, sessionsTotal: 3, found: 2, updatedAt: RECENT } },
    NOW,
  )
  expect(line).toBe('1/3 sessions · 2 found')
})

test('status line: stale progress falls through to the backlog', async () => {
  const line = statusLine(
    { eligibleSessions: 1, updatedAt: RECENT, runProgress: { sessionsDone: 1, sessionsTotal: 3, updatedAt: LAST_WEEK } },
    NOW,
  )
  expect(line).toBe('1 session not yet captured')
})

test('status line: an old census says nothing', async () => {
  expect(statusLine({ eligibleSessions: 3, updatedAt: LAST_WEEK }, NOW)).toBe('')
})

test('reply: a fenced or prefaced reply is cut down to its JSON', async () => {
  expect(parseReply('```json\n{"candidates":[]}\n```')).toEqual({ candidates: [] })
  expect(parseReply('Here it is:\n{"kind":"NEW"}')).toEqual({ kind: 'NEW' })
  expect(parseReply('[1,2]')).toEqual([1, 2])
})

test('prompt: the schema goes out with the request', async () => {
  const prompt = promptFor({ node: 'critic', system: 's', user: 'the transcript', schema: { type: 'object' } })
  expect(prompt.startsWith('the transcript')).toBe(true)
  expect(prompt.endsWith('{"type":"object"}')).toBe(true)
})

test('outcome: a pull request is named', async () => {
  const outcome = { url: 'https://github.com/o/r/pull/7', pr: 7, reason: null, manualCommand: null }
  expect(outcomeLine(2, 1, outcome)).toBe('2 changes proposed — https://github.com/o/r/pull/7')
  expect(outcomeLine(0, 3, null)).toBe('3 sessions read, nothing proposed')
})

test('outcome: no pull request says so, and where the command is', async () => {
  const outcome = { url: null, pr: null, reason: 'could not open a pull request: HTTP 404', manualCommand: 'gh pr create ...' }
  expect(outcomeLine(2, 1, outcome)).toBe(
    '2 changes committed, but could not open a pull request: HTTP 404. The command to finish it is in the signposts pane (/signposts-pane)',
  )
})

test('outcome: a stale pull request names it and asks nothing', async () => {
  const outcome = { url: null, pr: 5, reason: 'the pull request body and labels are stale: HTTP 502', manualCommand: null }
  expect(outcomeLine(1, 1, outcome)).toBe('1 change committed on PR #5, but the pull request body and labels are stale: HTTP 502')
})

test('search: claims come from the result, its structuredContent or a string', async () => {
  const output = { results: [{ claim: 'Embeddings run locally', category: 'decision' }] }
  const claims = [{ claim: 'Embeddings run locally', category: 'decision' }]
  expect(claimsIn(output)).toEqual(claims)
  expect(claimsIn({ content: [], structuredContent: output })).toEqual(claims)
  expect(claimsIn(JSON.stringify(output))).toEqual(claims)
  expect(claimsIn({ results: [], diagnostic: 'nothing recorded here' })).toEqual([])
  expect(claimsIn('not json')).toEqual([])
})

test('transcript: a group is hidden only when it holds the search and what loaded it', async () => {
  const search = 'mcp__plugin_signposts_signposts__search_signposts'
  expect(isSearchOnly([search])).toBe(true)
  expect(isSearchOnly(['ToolSearch', search])).toBe(true)
  expect(isSearchOnly(['ToolSearch'])).toBe(false)
  expect(isSearchOnly(['Read', search])).toBe(false)
})
