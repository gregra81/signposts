// The review prompt's text. What matters in every case below is that the
// screen says what the operation actually does: a claim shown under `-` is a
// claim being taken away, and an operation that takes nothing away must never
// print one.

import { describe, expect, it } from "vitest";
import { GATE_REASONS, OPERATION_TAGS } from "../../../src/core/contracts/graph.js";
import {
  formatWaited,
  renderItem,
  renderPendingList,
  targetId,
} from "../../../src/core/review/render.js";
import type { GateReason, Operation } from "../../../src/core/contracts/graph.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

const BEFORE: Signpost = {
  id: "staging-writable",
  claim: "Staging is writable at any time",
  category: "environment",
  scope: { repo: "acme/api" },
  evidence: "From an earlier session.",
  confidence: 0.8,
  provenance: {
    session_ids: ["sess-0"],
    authors: ["dev@acme.example"],
    first_seen: "2026-01-01",
    last_reinforced: "2026-01-01",
  },
  status: "active",
};

const REPLACEMENT: Signpost = {
  ...BEFORE,
  id: "staging-read-only",
  claim: "Staging is read only outside the ETL window",
  evidence: "A migration against staging was refused.",
};

const NOW = new Date("2026-09-08T12:00:00.000Z");

function render(
  operation: Operation,
  before?: Signpost,
  reason: GateReason = GATE_REASONS.edits_existing,
) {
  return renderItem({ operation, reason, ...(before === undefined ? {} : { before }) });
}

describe("targetId", () => {
  it("is the id an add would create", () => {
    expect(targetId({ op: OPERATION_TAGS.add, signpost: REPLACEMENT })).toBe("staging-read-only");
  });

  it("is the id every other operation acts on", () => {
    expect(targetId({ op: OPERATION_TAGS.retire, id: "staging-writable", reason: "gone" })).toBe(
      "staging-writable",
    );
  });
});

describe("renderItem", () => {
  it("shows an add as the claim it would record, with no before", () => {
    const text = render({ op: OPERATION_TAGS.add, signpost: REPLACEMENT }, undefined, GATE_REASONS.low_confidence);

    expect(text).toBe(
      `add staging-read-only — the model was not confident\n` +
        `+ ${REPLACEMENT.claim}\n` +
        `  why: ${REPLACEMENT.evidence}`,
    );
  });

  it("shows a supersede as the claim replaced by the new one", () => {
    const text = render(
      { op: OPERATION_TAGS.supersede, id: BEFORE.id, replacement: REPLACEMENT },
      BEFORE,
    );

    expect(text).toBe(
      `supersede staging-writable — it changes a signpost you already have\n` +
        `- ${BEFORE.claim}\n` +
        `+ ${REPLACEMENT.claim}\n` +
        `  why: ${REPLACEMENT.evidence}`,
    );
  });

  it("shows only the new claim when what it targets is itself still a proposal", () => {
    const text = render(
      { op: OPERATION_TAGS.supersede, id: BEFORE.id, replacement: REPLACEMENT },
      undefined,
      GATE_REASONS.pending_neighbour,
    );

    expect(text).toBe(
      `supersede staging-writable — it targets a proposal you have not accepted yet\n` +
        `+ ${REPLACEMENT.claim}\n` +
        `  why: ${REPLACEMENT.evidence}`,
    );
  });

  it("shows a refine's new wording against the old", () => {
    const text = render(
      { op: OPERATION_TAGS.refine, id: BEFORE.id, claim: "Staging is writable only at night", evidence: "Narrowed." },
      BEFORE,
    );

    expect(text).toBe(
      `refine staging-writable — it changes a signpost you already have\n` +
        `- ${BEFORE.claim}\n` +
        `+ Staging is writable only at night\n` +
        `  why: Narrowed.`,
    );
  });

  it("keeps the claim, and prints the scope, for a refine that only narrows scope", () => {
    const text = render(
      { op: OPERATION_TAGS.refine, id: BEFORE.id, scope: { repo: "acme/api", paths: ["db/"] } },
      BEFORE,
    );

    // Not `- claim` followed by nothing: a scope-only refine removes no claim.
    expect(text).toBe(
      `refine staging-writable — it changes a signpost you already have\n` +
        `= ${BEFORE.claim}\n` +
        `  scope: {"repo":"acme/api","paths":["db/"]}`,
    );
  });

  it("describes a scope-only refine even when the target is not recorded yet", () => {
    const text = render({ op: OPERATION_TAGS.refine, id: BEFORE.id }, undefined);

    expect(text).toBe(
      `refine staging-writable — it changes a signpost you already have\n` +
        `= narrows the scope, leaving the claim as it is`,
    );
  });

  it("shows a reinforce as the claim it leaves exactly as it is", () => {
    const text = render(
      { op: OPERATION_TAGS.reinforce, id: BEFORE.id, sessionId: "sess-1", author: "dev@acme.example" },
      BEFORE,
      GATE_REASONS.bootstrap_run,
    );

    expect(text).toBe(
      `reinforce staging-writable — this repo's first run, so everything is reviewed\n` +
        `= ${BEFORE.claim}`,
    );
  });

  it("says what a reinforce does when the claim it repeats is not recorded yet", () => {
    const text = render(
      { op: OPERATION_TAGS.reinforce, id: BEFORE.id, sessionId: "sess-1", author: "dev@acme.example" },
      undefined,
      GATE_REASONS.pending_neighbour,
    );

    expect(text).toBe(
      `reinforce staging-writable — it targets a proposal you have not accepted yet\n` +
        `= another session said the same thing`,
    );
  });

  it("shows a retire as the claim it removes, and the reason given", () => {
    const text = render(
      { op: OPERATION_TAGS.retire, id: BEFORE.id, reason: "The replica is writable now." },
      BEFORE,
      GATE_REASONS.deletes_existing,
    );

    expect(text).toBe(
      `retire staging-writable — it removes a signpost you already have\n` +
        `- ${BEFORE.claim}\n` +
        `  why: The replica is writable now.`,
    );
  });

  it("still says a retire removes something when the claim cannot be read", () => {
    const text = render(
      { op: OPERATION_TAGS.retire, id: BEFORE.id, reason: "Obsolete." },
      undefined,
      GATE_REASONS.deletes_existing,
    );

    expect(text).toContain("- removes this signpost");
  });

  it("names an unresolved contradiction as the reason it stopped", () => {
    const text = render(
      { op: OPERATION_TAGS.supersede, id: BEFORE.id, replacement: REPLACEMENT },
      BEFORE,
      GATE_REASONS.unresolved_contradiction,
    );

    expect(text).toContain("it contradicts what is recorded and nothing could settle which is right");
  });
});

describe("formatWaited", () => {
  it("counts whole hours under a day", () => {
    expect(formatWaited(new Date("2026-09-08T09:30:00.000Z"), NOW)).toBe("2 hours");
  });

  it("says one hour, not one hours", () => {
    expect(formatWaited(new Date("2026-09-08T11:00:00.000Z"), NOW)).toBe("1 hour");
  });

  it("is zero hours for a halt that just happened", () => {
    expect(formatWaited(NOW, NOW)).toBe("0 hours");
  });

  it("never counts backwards when a clock has moved", () => {
    expect(formatWaited(new Date("2026-09-08T13:00:00.000Z"), NOW)).toBe("0 hours");
  });

  it("counts whole days above one", () => {
    expect(formatWaited(new Date("2026-09-06T11:00:00.000Z"), NOW)).toBe("2 days");
  });

  it("says one day at exactly a day", () => {
    expect(formatWaited(new Date("2026-09-07T12:00:00.000Z"), NOW)).toBe("1 day");
  });

  it("reports the age of a halt about to expire", () => {
    expect(formatWaited(new Date("2026-07-28T12:00:00.000Z"), NOW)).toBe("42 days");
  });
});

describe("renderPendingList", () => {
  it("says so when nothing is waiting", () => {
    expect(renderPendingList([], NOW)).toBe("Nothing is waiting for review.");
  });

  it("numbers each session, with what it holds and how long it has held it", () => {
    const text = renderPendingList(
      [
        { sessionId: "sess-1", waitingSince: new Date("2026-09-05T12:00:00.000Z"), operations: 2 },
        { sessionId: "sess-2", waitingSince: new Date("2026-09-08T11:00:00.000Z"), operations: 1 },
      ],
      NOW,
    );

    expect(text).toBe(
      "2 sessions waiting for review:\n" +
        "  1. session sess-1 — 2 operations, waiting 3 days\n" +
        "  2. session sess-2 — 1 operation, waiting 1 hour",
    );
  });

  it("does not pluralise a single session", () => {
    const text = renderPendingList(
      [{ sessionId: "sess-1", waitingSince: NOW, operations: 1 }],
      NOW,
    );

    expect(text.split("\n")[0]).toBe("1 session waiting for review:");
  });
});
