// Creates `.signposts/` if absent (R3/R4). One line; its own file so
// src/cli/commands/init.ts and index.ts share it instead of each calling
// node:fs directly.

import { mkdirSync } from "node:fs";

export function ensureKnowledgeDir(knowledgeDir: string): void {
  mkdirSync(knowledgeDir, { recursive: true });
}
