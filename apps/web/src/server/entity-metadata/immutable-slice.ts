import { isEqual } from "es-toolkit";
import { z } from "zod";

/** Metadata is compiler-owned JSON. Exact equality validates the entire slice,
 * including nested declarations, without a second hand-maintained schema. */
export function immutableMetadataSchema<const T>(expected: T) {
  return z
    .custom<T>((value) => isEqual(value, expected))
    .transform(freezeMetadata);
}

function freezeMetadata<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freezeMetadata(child);
    Object.freeze(value);
  }
  return value;
}
