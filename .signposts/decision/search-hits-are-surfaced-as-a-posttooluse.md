---
id: search-hits-are-surfaced-as-a-posttooluse
claim: Search hits are surfaced as a PostToolUse systemMessage row, not a
  MessageDisplay rewrite of Claude's text, which was deferred as model-dependent
  and run on every streamed batch.
category: decision
scope:
  repo: gregra81/signposts
  paths:
    - hooks/session-start.ts
  tools:
    - mcp__plugin_signposts_signposts__search_signposts
confidence: 0.7
status: active
provenance:
  session_ids:
    - 46bbe9e3-1114-4d25-87b0-46d89434bb68
  authors:
    - rashkevitch@gmail.com
  first_seen: 2026-10-12T15:19:40.510Z
  last_reinforced: 2026-10-12T15:19:40.510Z
---

Assistant recommended shipping the PostToolUse row now and adding MessageDisplay only if the row is not enough, citing that MessageDisplay needs Claude to tag sentences, fires on every streamed batch (~20ms each) and has unknown rendering; human replied 'yeah, agree'.
