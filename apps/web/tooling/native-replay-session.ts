import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

// agent-device isolates replay daemons and removes them after synchronous
// reporter callbacks. Match its session normalization without following links.
export function* replaySessionRoots(temporaryRoot: string, session: string) {
  const name = session.replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
  if (!name || name === "." || name === "..") return;
  try {
    for (const directory of readdirSync(temporaryRoot, {
      withFileTypes: true,
    })) {
      if (
        !directory.isDirectory() ||
        !directory.name.startsWith("agent-device-replay-daemon-")
      )
        continue;
      const root = join(temporaryRoot, directory.name, "sessions", name);
      try {
        if (lstatSync(root).isDirectory()) yield root;
      } catch {
        // Other live daemons need not contain this replay session.
      }
    }
  } catch {
    return;
  }
}
