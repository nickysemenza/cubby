import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ARTIFACT_MANIFEST } from "./generator/artifact-manifest.ts";

const scopeSchema = z.enum(["host", "app"]);

// Hash the generator's declared outputs, not arbitrary ignored files a local
// build/editor leaves under Sources. Missing output must never yield a pass.
export function appleGeneratedDigest(
  root: string,
  scope: z.infer<typeof scopeSchema>,
): string {
  const paths = z
    .array(z.string())
    .parse(JSON.parse(readFileSync(join(root, ARTIFACT_MANIFEST), "utf8")))
    .filter((path) =>
      path.startsWith(
        scope === "host" ? "apps/apple/CubbyKit/" : "apps/apple/",
      ),
    )
    .sort();
  if (paths.length === 0)
    throw new Error(`No generated Apple ${scope} inputs; run pnpm generate`);
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path).update("\0");
    hash.update(readFileSync(join(root, path))).update("\0");
  }
  return hash.digest("hex");
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  console.log(appleGeneratedDigest(root, scopeSchema.parse(process.argv[2])));
}
