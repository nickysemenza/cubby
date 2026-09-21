import { imageShortcode } from "@cubby/schemas/identifiers";
import type { ImageRepresentations } from "@cubby/schemas/image-summary";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";

import { loadImageRepresentations } from "./image-processing";

const record = z.record(z.string(), z.unknown());
const imageReference = z.object({ id: imageShortcode, url: z.string() });

/** Hydrate nested image embeds as well as top-level attachments without changing originals. */
export async function hydrateImageReadProjection<T>(
  db: Database | DrizzleTransaction,
  value: T,
): Promise<T> {
  const codes = new Set<string>();
  function visit<Node>(
    input: Node,
    representations?: ReadonlyMap<string, ImageRepresentations>,
  ): Node {
    if (Array.isArray(input)) {
      // SAFETY: recursive hydration preserves every element and its original shape.
      return input.map((item) => visit(item, representations)) as Node;
    }
    const object = record.safeParse(input);
    if (!object.success) return input; // Date and scalar wire values retain their identity.
    const reference = imageReference.safeParse(input);
    if (reference.success) codes.add(reference.data.id);
    const hydrated = Object.fromEntries(
      Object.entries(object.data).map(([key, child]) => [
        key,
        visit(child, representations),
      ]),
    );
    // SAFETY: all fields survive; only the optional declared Image representation is added.
    return (
      reference.success && representations?.has(reference.data.id)
        ? {
            ...hydrated,
            representations: representations.get(reference.data.id),
          }
        : hydrated
    ) as Node;
  }
  visit(value);
  if (!codes.size) return value;
  const representations = await loadImageRepresentations(db, [...codes]);
  // SAFETY: the walk preserves every input field and only adds the declared
  // optional representations projection to valid public Image references.
  return visit(value, representations) as T;
}
