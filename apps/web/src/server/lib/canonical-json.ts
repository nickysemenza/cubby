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
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  // The input is validated JSON. Re-parsing every subtree clones the same
  // evidence repeatedly and allocates validation errors for every scalar.
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}
