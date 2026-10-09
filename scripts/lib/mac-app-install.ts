import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export function installMacApp(
  source: string,
  destination: string,
  verify: (app: string) => void,
  stop: () => void,
): string | undefined {
  verify(source);
  if (existsSync(destination)) {
    if (!lstatSync(destination).isDirectory())
      throw new Error(
        `Refusing to replace a non-directory app: ${destination}`,
      );
    verify(destination);
  }
  // Stage on the destination filesystem: both replacement and rollback use
  // rename, and a bad copied signature never touches the installed app.
  const staging = mkdtempSync(join(dirname(destination), ".cubby-install-"));
  const candidate = join(staging, "candidate.app");
  // Keep the previous bundle in the same parent. Moving a root-owned bundle
  // into a subdirectory can require write access to that bundle on macOS.
  const backup = join(
    dirname(destination),
    `${basename(staging)}.previous.app`,
  );
  try {
    cpSync(source, candidate, { recursive: true, verbatimSymlinks: true });
    verify(candidate);
    stop();
    if (existsSync(destination)) renameSync(destination, backup);
    try {
      renameSync(candidate, destination);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, destination);
      throw error;
    }
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch {
      return backup;
    }
  } finally {
    // A failed rollback leaves the sibling backup recoverable.
    rmSync(staging, { recursive: true, force: true });
  }
}
