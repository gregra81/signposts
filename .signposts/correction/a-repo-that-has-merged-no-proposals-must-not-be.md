---
id: a-repo-that-has-merged-no-proposals-must-not-be
claim: A repo that has merged no proposals must not be pointed at
  .signposts/index.md, which only exists once the first signposts PR merges.
category: correction
scope:
  repo: gregra81/signposts
  paths:
    - src/core/init/policy.ts
confidence: 0.9
status: active
provenance:
  session_ids:
    - fa3e404b-3ef6-4771-978f-0d3c63dc4c1b
  authors:
    - rashkevitch@gmail.com
  first_seen: 2026-09-23T10:26:46.332Z
  last_reinforced: 2026-09-23T10:26:46.332Z
---

it looks broken for a user and asks him to do stuff that he should not even worry about. Why would a user need to decide if they need to create the .signposts/index.md file at all?
