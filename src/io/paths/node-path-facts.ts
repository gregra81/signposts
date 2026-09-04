// The `PathFacts` port over `node:fs`, and the only place confinement
// touches a real filesystem.
//
// Everything here is a syscall plus the one errno translation that decides
// what "not there" means. The walk-up, the symlink hop budget and every
// containment decision stayed in src/core/paths/confine.ts, so this file
// carries no reasoning to get wrong and none of it is worth mutation-testing.

import fs from "node:fs";
import type { PathFacts } from "../../core/paths/confine.ts";

/** `ENOENT` is the one failure that means "nothing is there", not "this went wrong". */
const NOT_FOUND = "ENOENT";

export const nodePathFacts: PathFacts = {
  lstat(p) {
    try {
      // Reduced to the single question confine asks. Returning fs.Stats would
      // hand core a `node:fs` type and put the dependency straight back.
      return { isSymbolicLink: fs.lstatSync(p).isSymbolicLink() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === NOT_FOUND) return undefined;
      // ENOTDIR on a path running through a file, ELOOP, EACCES: all real
      // failures, and confine turns each into a `confine failed` reason.
      throw err;
    }
  },

  readlink(p) {
    return fs.readlinkSync(p);
  },

  realpath(p) {
    return fs.realpathSync(p);
  },
};
