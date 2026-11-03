import { z } from "zod";

/** Normalize dates and optional properties before hashing persisted JSON inputs. */
export const jsonSnapshot = z.preprocess(
  (value) => JSON.parse(JSON.stringify(value ?? null)),
  z.json(),
);

/** Stable object ordering for Assessment and mutation input fingerprints. */
export function canonicalJson(
  value: z.infer<ReturnType<typeof z.json>>,
): string {
  const fragments: string[] = [];
  writeCanonicalJson(value, (fragment) => fragments.push(fragment));
  return fragments.join("");
}

/** Emit complete JSON tokens so consumers can avoid retaining the whole string. */
export function writeCanonicalJson(
  value: z.infer<ReturnType<typeof z.json>>,
  write: (fragment: string) => void,
): void {
  if (Array.isArray(value)) {
    write("[");
    for (let index = 0; index < value.length; index++) {
      if (index) write(",");
      if (index in value) writeCanonicalJson(value[index]!, write);
    }
    write("]");
    return;
  }
  // The input is validated JSON. Re-parsing every subtree clones the same
  // evidence repeatedly and allocates validation errors for every scalar.
  if (value === null || typeof value !== "object") {
    write(JSON.stringify(value));
    return;
  }
  write("{");
  for (const [index, key] of Object.keys(value).sort().entries()) {
    if (index) write(",");
    write(JSON.stringify(key));
    write(":");
    writeCanonicalJson(value[key]!, write);
  }
  write("}");
}
