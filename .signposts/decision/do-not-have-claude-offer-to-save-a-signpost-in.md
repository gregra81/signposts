---
id: do-not-have-claude-offer-to-save-a-signpost-in
claim: Do not have Claude offer to save a signpost in the moment a developer
  corrects it; the team rejected in-session prompts because developers would
  come to hate the tool.
category: decision
scope:
  repo: gregra81/signposts
  paths:
    - hooks/session-start.ts
    - skills/signposts/SKILL.md
confidence: 0.8
status: active
provenance:
  session_ids:
    - b6060d52-b348-4f08-b7bf-23c6f6b9f208
  authors:
    - rashkevitch@gmail.com
  first_seen: 2026-09-29T04:14:24.989Z
  last_reinforced: 2026-09-29T04:14:24.989Z
---

Assistant proposed moving capture to the moment of correction (Claude drafts and offers the claim right then). Human: "no, this will make developers hate the tool. What if the proposals will be agregated behind the scenes and show in the status line"
