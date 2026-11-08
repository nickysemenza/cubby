import { imageShortcode } from "@cubby/schemas/identifiers";
import type { ImageRepresentations } from "@cubby/schemas/image-summary";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { loadImageRepresentations } from "~/server/domains/image-processing/repo/image-processing";

const record = z.record(z.string(), z.unknown());
const imageReference = z.object({ id: imageShortcode, url: z.string() });

/** Hydrate nested image embeds as well as top-level attachments without changing originals. */
export async function hydrateImageReadProjection<T>(
  db: Database | DrizzleTransaction,
  value: T,
  // Only pass authoritative results resolved during this read, never values
  // recovered from the input's optional representations fields.
  preloaded?: ReadonlyMap<string, ImageRepresentations>,
): Promise<T> {
  const codes = new Set<string>();
  const references: { id: string; value: z.infer<typeof record> }[] = [];
  function visit<Node>(input: Node): Node {
    if (Array.isArray(input)) {
      // SAFETY: every array element retains its original shape.
      return input.map(visit) as Node;
    }
    if (input === null || typeof input !== "object") return input;
    const object = record.safeParse(input);
    if (!object.success) return input;
    const reference =
      "id" in input && "url" in input ? imageReference.safeParse(input) : null;
    if (reference?.success) codes.add(reference.data.id);
    // Parse once into fresh clones; only these clones receive representations.
    const hydrated = object.data;
    for (const [key, child] of Object.entries(hydrated))
      hydrated[key] = visit(child);
    if (reference?.success) {
      references.push({ id: reference.data.id, value: hydrated });
    }
    // SAFETY: the parsed record retains its fields and recursively hydrated values.
    return hydrated as Node;
  }
  const hydrated = visit(value);
  if (!codes.size) return value;
  const missing = [...codes].filter((code) => !preloaded?.has(code));
  const representations = new Map(preloaded);
  if (missing.length) {
    for (const [code, representation] of await loadImageRepresentations(
      db,
      missing,
    )) {
      representations.set(code, representation);
    }
  }
  for (const reference of references) {
    if (representations.has(reference.id))
      reference.value.representations = representations.get(reference.id);
  }
  return hydrated;
}
