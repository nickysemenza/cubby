import { isEqual } from "es-toolkit";
import { z } from "zod";

import { freezeMetadata } from "~/entity/immutable-metadata";

/** Metadata is compiler-owned JSON. Exact equality validates the entire slice,
 * including nested declarations, without a second hand-maintained schema. */
export function immutableMetadataSchema<const T>(expected: T) {
  return z
    .custom<T>((value) => isEqual(value, expected))
    .transform(freezeMetadata);
}
