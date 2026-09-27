// The allow rules setup adds to `.claude/settings.local.json`, so driving a
// run does not stop for a permission prompt at every halt.
//
// A run is a loop of `signpost resume` calls, each after writing the halt's
// answers to a file. Under Claude Code's default permission mode every one of
// those is a prompt: two per halt, several halts per session, all asking the
// developer to approve the same two things. In the cold walkthrough the
// subagent also tried `/tmp` and a heredoc before it found a place it could
// write at all (19-value-to-a-user.md, open item 17, and "Fewer human steps").
//
// Two rules, as narrow as the loop allows: the `signpost` binary, and the one
// replies file in the state directory. Merged into whatever `allow` list is
// there, never replacing it.
//
// PURE.

import type { Settings } from "./statusline-settings.ts";

const BASH_RULE = "Bash(signpost *)";

/**
 * The rules, for a replies file at `repliesPath`. `Edit` covers Write as well;
 * `//` is how a permission rule names an absolute path.
 */
export function allowRulesFor(repliesPath: string): string[] {
  return [BASH_RULE, `Edit(/${repliesPath})`];
}

/** `settings` with `rules` in `permissions.allow`, plus whether anything was added. */
export function planPermissions(settings: Settings, rules: readonly string[]): { settings: Settings; added: string[] } {
  const permissions =
    typeof settings["permissions"] === "object" && settings["permissions"] !== null
      ? (settings["permissions"] as Record<string, unknown>)
      : {};
  const allow = Array.isArray(permissions["allow"]) ? (permissions["allow"] as unknown[]) : [];
  const added = rules.filter((rule) => !allow.includes(rule));
  if (added.length === 0) {
    return { settings, added };
  }
  return {
    settings: { ...settings, permissions: { ...permissions, allow: [...allow, ...added] } },
    added,
  };
}
