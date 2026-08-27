// Filesystem reader for `.signposts/**/*.md` (R4, `signpost index`). Thin:
// walks the directory and returns raw file text; parsing is
// src/core/signpost/codec.ts's parseSignpost, called by the caller
// (src/cli/commands/index.ts). `index.md` is excluded — it's generated
// output (generateIndexDoc), not a signpost source file.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { INDEX_FILENAME } from "../../core/config/constants.ts";

export interface SignpostFile {
  path: string;
  content: string;
}

/** Empty array if `knowledgeDir` does not exist yet (a repo before its first `index` run). */
export function readSignpostFiles(knowledgeDir: string): SignpostFile[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(knowledgeDir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== INDEX_FILENAME)
    .map((entry) => {
      const filePath = path.join(entry.parentPath, entry.name);
      return { path: filePath, content: readFileSync(filePath, "utf8") };
    });
}
