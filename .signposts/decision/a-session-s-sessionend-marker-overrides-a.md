---
id: a-session-s-sessionend-marker-overrides-a
claim: "A session's SessionEnd marker overrides a configured idleHours in both
  directions: even an operator who set a longer idle window gets zero wait for
  an ended session."
category: decision
scope:
  repo: gregra81/signposts
  paths:
    - src/core/eligibility/eligibility.ts
    - hooks/session-start.ts
confidence: 0.7
status: active
provenance:
  session_ids:
    - 96c608bf-b844-428f-9525-f8f2e883358c
  authors:
    - rashkevitch@gmail.com
  first_seen: 2026-10-04T14:39:54.888Z
  last_reinforced: 2026-10-04T14:39:54.888Z
---

Assistant asked: 'Leave as is, or have the marker respect a longer configured window?' (SIGNPOSTS_THRESHOLDS_IDLE_HOURS=48 would now get zero wait on every /clear). Human: 'leave as is'.
