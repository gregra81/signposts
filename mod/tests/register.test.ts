import { expect, test } from 'claude-code/testing'

import { parseReply, promptFor, statusLine } from '../hooks/register.tsx'

const NOW = Date.parse('2026-10-12T12:00:00.000Z')
const RECENT = '2026-10-12T11:58:00.000Z'
const LAST_WEEK = '2026-10-05T12:00:00.000Z'

test('status line: a run in flight outranks everything', async () => {
  const line = statusLine(
    { unpublishedSessions: 2, eligibleSessions: 4, updatedAt: RECENT, runProgress: { sessionsDone: 1, sessionsTotal: 3, found: 2, updatedAt: RECENT } },
    NOW,
  )
  expect(line).toBe('🪧 signposts: 1/3 sessions · 2 found')
})

test('status line: stale progress falls through to the backlog', async () => {
  const line = statusLine(
    { eligibleSessions: 1, updatedAt: RECENT, runProgress: { sessionsDone: 1, sessionsTotal: 3, updatedAt: LAST_WEEK } },
    NOW,
  )
  expect(line).toBe('🪧 signposts: 1 session not yet captured')
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
