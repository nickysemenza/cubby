import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Fold file mtimes below `dir`, pruning named directories and watching only
 * the requested extensions. Unreadable paths are ignored like a missing tree.
 */
export const extremeMtime = (
  dir,
  { pick, seed, prune, extensions },
) => {
  let acc = seed;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!prune.has(entry.name)) {
        acc = pick(
          acc,
          extremeMtime(full, { pick, seed, prune, extensions }),
        );
      }
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      try {
        acc = pick(acc, statSync(full).mtimeMs);
      } catch {
        // An entry can disappear between readdir and stat; ignore it.
      }
    }
  }
  return acc;
};
