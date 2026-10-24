---
id: storage-mode-repo-vs-personal-is-chosen-per
claim: Storage mode (repo vs personal) is chosen per repo via `signpost init`,
  not globally, because some repos keep signposts in the repo and others keep
  them private.
category: decision
scope:
  repo: gregra81/signposts
  paths:
    - src/io/config.ts
  tools:
    - signpost init
confidence: 0.82
status: active
provenance:
  session_ids:
    - 42be8609-1521-42f0-bf25-f90223cfe04c
  authors:
    - rashkevitch@gmail.com
  first_seen: 2026-10-24T11:21:33.044Z
  last_reinforced: 2026-10-24T11:21:33.044Z
---

After the assistant explained the global ~/.signposts/config.yaml / SIGNPOSTS_STORAGE setting, the human said: "it should not be global but on the repo level. for some repos it will be in the repo and for some it will be local / private. this config should be part of the init command"
