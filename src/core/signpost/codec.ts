// parse/serialise for the on-disk Signpost format (03-memory-model.md "On-disk
// format"): YAML frontmatter delimited by `---` lines, a blank line, then the
// `evidence` field as the markdown body. Frontmatter never repeats evidence.
//
// serialiseSignpost is deterministic: the frontmatter object is built with a
// fixed key order every call and yaml's stringify carries no timestamps or
// other nondeterminism, so two calls on the same Signpost produce
// byte-identical output, and parseSignpost(serialiseSignpost(s)) deep-equals
// s (16-build-plan.md P6).

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { signpostSchema, type Signpost } from "./schema.ts";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/;

export function parseSignpost(text: string): Signpost {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    throw new Error("not a valid signpost file: expected `---`-delimited YAML frontmatter followed by a blank line");
  }
  const [, frontmatterText, body] = match;

  const frontmatter: unknown = parseYaml(frontmatterText!);
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    throw new Error("malformed signpost frontmatter: expected a YAML mapping");
  }

  // serialiseSignpost always terminates the file with exactly one trailing
  // newline after evidence; strip only that one so internal newlines in a
  // multi-sentence evidence field survive the round trip.
  const evidence = body!.replace(/\n$/, "");

  return signpostSchema.parse({ ...frontmatter, evidence });
}

export function serialiseSignpost(signpost: Signpost): string {
  const frontmatter: Record<string, unknown> = {
    id: signpost.id,
    claim: signpost.claim,
    category: signpost.category,
    scope: signpost.scope,
    confidence: signpost.confidence,
    status: signpost.status,
    provenance: signpost.provenance,
  };
  frontmatter.supersedes = signpost.supersedes;

  const yamlText = stringifyYaml(frontmatter).trimEnd();
  return `---\n${yamlText}\n---\n\n${signpost.evidence}\n`;
}
