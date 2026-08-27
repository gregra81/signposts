// Production Forge placeholder. The real hosted-PR integration (via `gh`)
// is Slice C (15-spec.md D1's Forge port is defined now so the type is
// fixed; wiring it to `gh pr ...` lands with the run/review commands that
// actually call it — out of scope here, same "not implemented" precedent
// as src/io/model/recording-provider.ts's Slice-B stub). init/index/doctor
// never call Forge, so this only exists to satisfy the Ports type at the
// composition root.

import type { Forge } from "../../app.ts";

function notImplemented(): never {
  throw new Error("Forge is not implemented yet — Slice C");
}

export const stubForge: Forge = {
  hasOpenPr: () => notImplemented(),
  openPr: () => notImplemented(),
  updatePr: () => notImplemented(),
  setLabels: () => notImplemented(),
};
