// Embedding-model cache presence check (R5) — just a directory existence
// probe; whether the cache is populated enough to embed with is not
// checked here (that's what the real embed call proves, elsewhere).

import { existsSync } from "node:fs";

export function checkModelCachePresent(modelCacheDir: string): boolean {
  return existsSync(modelCacheDir);
}
