---
id: personal-storage-mode-writes-signposts-to-a
claim: Personal storage mode writes signposts to a plain local folder with no
  git; the git-backed personal store was rejected, while repo mode keeps the
  branch, commit and PR flow.
category: decision
scope:
  repo: gregra81/signposts
  paths:
    - src/io/git/worktree.ts
confidence: 0.6
status: active
provenance:
  session_ids:
    - 42be8609-1521-42f0-bf25-f90223cfe04c
  authors:
    - rashkevitch@gmail.com
  first_seen: 2026-10-24T11:21:33.044Z
  last_reinforced: 2026-10-24T11:21:33.044Z
---

Human on PR 82: "I'm thinking I don't want it to be in git at all", then "sure, but only for the personal storage mode". No reason was given beyond that preference.
