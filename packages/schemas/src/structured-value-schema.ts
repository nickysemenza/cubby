/** Structured editor shapes share the native manifest wire description. Validation remains
 * server-owned; these descriptions only tell generic editors what to draw and project.
 */
import type { ManifestWire, WireValue } from "./manifest-wire.ts";

export type StructuredOption = ManifestWire<"LabeledOption">;
export type StructuredField = ManifestWire<"ValueSchema.Field">;
export type StructuredTextFormat = WireValue<"StructuredTextFormat~">;
export type StructuredNode = ManifestWire<"ValueSchema.Node">;
export type StructuredJson = WireValue<"Json">;
export type StructuredValueSchema = ManifestWire<"ValueSchema">;
