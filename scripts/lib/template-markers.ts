import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function serviceDirectory(url: string): string {
  return join(
    tmpdir(),
    "cubby-template-initializers",
    createHash("sha1").update(url).digest("hex"),
  );
}

/** Clients must share both this host directory and the service incarnation. */
export function templateMarkerDirectory(
  url: string,
  incarnation?: string,
): string {
  const directory = join(
    serviceDirectory(url),
    incarnation
      ? createHash("sha1").update(incarnation).digest("hex")
      : "unverified",
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** Only the service owner retires obsolete incarnations, or all markers at teardown. */
export function retireTemplateMarkers(url: string, incarnation?: string): void {
  const directory = serviceDirectory(url);
  if (!existsSync(directory)) return;
  const keep = incarnation
    ? createHash("sha1").update(incarnation).digest("hex")
    : undefined;
  for (const entry of readdirSync(directory)) {
    if (entry !== keep)
      rmSync(join(directory, entry), { recursive: true, force: true });
  }
}
