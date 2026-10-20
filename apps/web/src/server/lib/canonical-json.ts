import { z } from "zod";

/** Normalize dates and optional properties before hashing persisted JSON inputs. */
export const jsonSnapshot = z.preprocess(
  (value) => JSON.parse(JSON.stringify(value ?? null)),
  z.json(),
);

const jsonObject = z.record(z.string(), z.json());

/** Stable object ordering for Assessment and mutation input fingerprints. */
export function canonicalJson(
  value: z.infer<ReturnType<typeof z.json>>,
): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = jsonObject.safeParse(value);
  if (!object.success) return JSON.stringify(value);
  return `{${Object.keys(object.data)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object.data[key]!)}`)
    .join(",")}}`;
}
