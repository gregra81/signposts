// Generates `.signposts/index.md` (03-memory-model.md: "a table of every
// active claim grouped by category. It is what a human skims and what
// CLAUDE.md points at."). Superseded signposts are excluded — the index is
// current knowledge, not history.

import { ACTIVE_STATUS, categorySchema, type Signpost } from "./schema.ts";

// Single source of truth for category order: the schema's own enum values,
// not a second hand-maintained list.
const CATEGORY_ORDER = categorySchema.options;

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderSection(category: string, signposts: readonly Signpost[]): string {
  const rows = signposts
    .map((s) => `| \`${s.id}\` | ${escapeCell(s.claim)} | ${escapeCell(s.scope.repo)} |`)
    .join("\n");
  return `## ${category}\n\n| id | claim | repo |\n| --- | --- | --- |\n${rows}\n`;
}

export function generateIndexDoc(signposts: readonly Signpost[]): string {
  const active = signposts.filter((s) => s.status === ACTIVE_STATUS);
  if (active.length === 0) {
    return "# Signposts\n\nNo active signposts.\n";
  }

  const byCategory = new Map<string, Signpost[]>();
  for (const signpost of active) {
    const bucket = byCategory.get(signpost.category);
    if (bucket) {
      bucket.push(signpost);
    } else {
      byCategory.set(signpost.category, [signpost]);
    }
  }

  const sections = CATEGORY_ORDER.filter((category) => byCategory.has(category)).map((category) =>
    renderSection(category, byCategory.get(category)!),
  );

  return `# Signposts\n\n${sections.join("\n")}`;
}
