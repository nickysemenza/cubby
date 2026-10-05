import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const lockfile = z.object({
  pins: z.array(
    z
      .object({
        identity: z.string(),
        location: z.string(),
        state: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
  ),
});

/**
 * Xcode can serialize its app graph into a local package's lockfile. CubbyKit
 * owns that tracked file; the generated Xcode project owns app-only pins.
 * Accept only unchanged Kit pins and additions from the app's declared URLs,
 * then restore the Kit serialization. An unexpected resolution fails the run.
 */
export async function withKitPackageResolution<T>(
  root: string,
  run: () => Promise<T>,
): Promise<T> {
  const file = path.join(root, "apps/apple/CubbyKit/Package.resolved");
  const original = readFileSync(file, "utf8");
  const owned = lockfile.parse(JSON.parse(original));
  const appLocations = new Set(
    [
      ...readFileSync(
        path.join(root, "apps/apple/project.yml"),
        "utf8",
      ).matchAll(/^\s+url:\s+(\S+)\s*$/gmu),
    ].map((match) => match[1]),
  );
  let result: { value: T } | undefined;
  const errors: unknown[] = [];
  try {
    result = { value: await run() };
  } catch (error) {
    errors.push(error);
  }
  try {
    const resolved = lockfile.parse(JSON.parse(readFileSync(file, "utf8")));
    for (const pin of owned.pins) {
      const after = resolved.pins.find(
        (candidate) => candidate.identity === pin.identity,
      );
      if (
        !after ||
        after.location !== pin.location ||
        !isDeepStrictEqual(after, pin)
      )
        throw new Error(
          `CubbyKit package pin changed during app resolution: ${pin.identity}`,
        );
    }
    for (const pin of resolved.pins) {
      if (
        !owned.pins.some((candidate) => candidate.identity === pin.identity) &&
        !appLocations.has(pin.location)
      )
        throw new Error(
          `Undeclared app package appeared in CubbyKit resolution: ${pin.identity}`,
        );
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    if (readFileSync(file, "utf8") !== original) writeFileSync(file, original);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(
      errors,
      "Native build and package ownership verification failed",
    );
  if (!result) throw new Error("Native build returned no outcome");
  return result.value;
}
