import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  type Stats,
} from "node:fs";
import { join, relative } from "node:path";

// Dependency-free on purpose: the native CI jobs fingerprint inputs before
// workspace dependencies are installed.

export interface WalkOptions {
  /** Names (files or directories) to leave out, at any depth. */
  skip?: (name: string) => boolean;
  /** Symlinks are omitted by default so a link never reads outside the tree. */
  includeSymlinks?: boolean;
}

/**
 * Every file under `target`, as absolute paths in lexical order. A file target
 * yields itself and a missing one yields nothing, so callers can list optional
 * inputs without an `existsSync` of their own.
 */
export function walkFiles(
  target: string,
  { skip, includeSymlinks = false }: WalkOptions = {},
): string[] {
  if (!existsSync(target)) return [];
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) return includeSymlinks ? [target] : [];
  if (stat.isFile()) return [target];
  return readdirSync(target, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) =>
      skip?.(entry.name)
        ? []
        : walkFiles(join(target, entry.name), { skip, includeSymlinks }),
    );
}

/**
 * SHA-256 over each file's path (relative to `root`) and bytes, in the order
 * given. A missing path is skipped, so a tracked file deleted in the working
 * tree changes the digest rather than throwing. Symlinks are skipped unless
 * `links` is set, where one contributes its target path and never the bytes
 * behind it. `seed` folds in a non-file input (a build flag) that must also
 * invalidate the digest.
 */
export function digestFiles(
  root: string,
  files: readonly string[],
  { seed, links = false }: { seed?: string; links?: boolean } = {},
): string {
  const hash = createHash("sha256");
  if (seed !== undefined) hash.update(seed).update("\0");
  for (const file of files) {
    const stat = lstatIfExists(file);
    if (!stat) continue;
    let content: string | Buffer;
    if (stat.isSymbolicLink()) {
      if (!links) continue;
      content = `link:${readlinkSync(file)}`;
    } else if (stat.isFile()) content = readFileSync(file);
    else continue;
    hash.update(relative(root, file)).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

/** Digest of every file under `directory` (see {@link walkFiles}, {@link digestFiles}). */
export const digestTree = (
  directory: string,
  options: WalkOptions = {},
): string =>
  digestFiles(directory, walkFiles(directory, options), {
    links: options.includeSymlinks,
  });

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
