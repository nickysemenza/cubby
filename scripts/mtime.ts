import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type ExtremeMtimeOptions = {
  pick: (a: number, b: number) => number;
  seed: number;
  prune: Set<string>;
  extensions: readonly string[];
};

export const extremeMtime = (
  dir: string,
  { pick, seed, prune, extensions }: ExtremeMtimeOptions,
): number => {
  let acc = seed;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!prune.has(entry.name)) {
        acc = pick(acc, extremeMtime(full, { pick, seed, prune, extensions }));
      }
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      try {
        acc = pick(acc, statSync(full).mtimeMs);
      } catch {}
    }
  }
  return acc;
};
