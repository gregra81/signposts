// An in-memory signpost mirror, built from a golden case's `mirror:` block.
//
// The recorder and the replay suite both need to run the graph against a
// mirror that already holds something. Without one, `classify` is asked
// "is this a duplicate?" while being handed an empty list, so it can only
// ever answer NOVEL — which is exactly what the first recording run
// produced: 61 classify calls, 61 NOVEL, and no coverage at all of
// DUPLICATE, REFINEMENT or CONTRADICTION (and therefore none of
// `resolve_conflict`).
//
// `find` returns every seeded signpost for the repo, ignoring the candidate.
// That is deliberate: this fixture exists to exercise the classifier, not
// retrieval. Ranking is src/io/db/neighbours.ts's job and has its own tests;
// putting a similarity function here would mean a golden case's outcome
// depended on a second unproven implementation.

import type { NeighbourPort, SignpostIndexPort } from "../../graph/ports.ts";
import { ACTIVE_STATUS, type Signpost } from "../../core/signpost/schema.ts";
import { MIRROR_SEED_CONFIDENCE, MIRROR_SEED_DATE } from "../../core/config/constants.ts";

/**
 * What a golden case actually writes. The mechanical half of a Signpost —
 * evidence, confidence, provenance, status — carries no information a
 * labeller is expressing, so it is filled in here rather than copied into
 * every fixture by hand.
 */
export interface MirrorSeed {
  id: string;
  claim: string;
  category: Signpost["category"];
  scope: Signpost["scope"];
}

export function toSignpost(seed: MirrorSeed, author: string): Signpost {
  return {
    id: seed.id,
    claim: seed.claim,
    category: seed.category,
    scope: seed.scope,
    evidence: "",
    confidence: MIRROR_SEED_CONFIDENCE,
    provenance: {
      session_ids: [],
      authors: [author],
      first_seen: MIRROR_SEED_DATE,
      last_reinforced: MIRROR_SEED_DATE,
    },
    status: ACTIVE_STATUS,
  };
}

/**
 * The `neighbours` and `index` ports for a run whose mirror already holds
 * `seeds`. An empty list gives back the same empty mirror the recorder used
 * before this existed, so a case without a `mirror:` block is unaffected.
 */
export function seededMirror(
  seeds: readonly MirrorSeed[],
  author: string,
): { neighbours: NeighbourPort; index: SignpostIndexPort } {
  const signposts = seeds.map((seed) => toSignpost(seed, author));
  const byId = new Map(signposts.map((s) => [s.id, s]));
  const forRepo = (repo: string) => signposts.filter((s) => s.scope.repo === repo);

  return {
    neighbours: {
      async find(repo) {
        return forRepo(repo);
      },
    },
    index: {
      async existingIds(repo) {
        return new Set(forRepo(repo).map((s) => s.id));
      },
      // A seeded mirror is by definition not a first run; an empty one is.
      async isBootstrap(repo) {
        return forRepo(repo).length === 0;
      },
      async byId(repo, id) {
        const found = byId.get(id);
        return found !== undefined && found.scope.repo === repo ? found : undefined;
      },
    },
  };
}
