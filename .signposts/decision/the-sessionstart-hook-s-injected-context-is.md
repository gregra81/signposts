---
id: the-sessionstart-hook-s-injected-context-is
claim: The SessionStart hook's injected context is scoped to startup and resume
  so it never lands mid-session, because a mid-session injection breaks prompt
  caching.
category: decision
scope:
  repo: gregra81/signposts
  paths:
    - hooks/hooks.json
confidence: 0.85
status: active
provenance:
  session_ids:
    - fa3e404b-3ef6-4771-978f-0d3c63dc4c1b
  authors:
    - rashkevitch@gmail.com
  first_seen: 2026-09-23T10:26:46.332Z
  last_reinforced: 2026-09-23T10:26:46.332Z
---

just making sure it's not going to be added everythime in the beginning or middle of the session to make sure caching is preserved
