import type { Cookbook, RunReport } from "@cubby/recipebridge";
import type {
  CookbookExtraction,
  CookbookRunReport,
} from "@cubby/schemas/cookbook";

/** Collapse an intersection back into a single object type. */
type Flatten<T> = { [K in keyof T]: T[K] };

/** Fields the generated types declare as present-but-possibly-`undefined`. */
type UndefinedKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];

/**
 * A wasm-generated type, restated as it survives `JSON.stringify`.
 *
 * The crate's types and the stored zod schemas describe the same JSON —
 * `packages/schemas/src/cookbook.ts` was written from the crate — but
 * TypeScript will not assign one to the other, for two reasons that are purely
 * about how each side is written down:
 *
 * 1. The schemas are zod passthrough objects, so every level carries an index
 *    signature (`[x: string]: JSONType`) for fields cubby does not read.
 *    TypeScript grants an *implicit* index signature to anonymous object types
 *    but never to an `interface`, and wasm-bindgen emits interfaces.
 * 2. wasm-bindgen writes a Rust `Option<T>` as `field: T | undefined` (present,
 *    possibly undefined); zod writes `field?: T` (possibly absent). Both mean
 *    the same thing after serialization, since `JSON.stringify` omits an
 *    undefined value — but only the optional form satisfies an index signature.
 *
 * Re-mapping each level fixes exactly those two things and nothing else: every
 * field name and every leaf type still has to match. That is why the
 * conversions below need no type assertion — they are ordinary assignments
 * that `tsc` checks in full, and they stop compiling the moment a real field
 * drifts.
 */
type Storable<T> = T extends readonly (infer U)[]
  ? Storable<U>[]
  : T extends object
    ? Flatten<
        {
          [K in Exclude<keyof T, UndefinedKeys<T>>]: Storable<T[K]>;
        } & {
          [K in UndefinedKeys<T>]?: Storable<Exclude<T[K], undefined>>;
        }
      >
    : T;

/** The crate's book tree, in the shape `upsertCookbook` stores. */
export const asStoredCookbook = (cookbook: Cookbook): CookbookExtraction => {
  const stored: Storable<Cookbook> = cookbook;
  return stored;
};

/** The crate's run report, in the shape `upsertCookbook` stores beside the tree. */
export const asStoredRunReport = (report: RunReport): CookbookRunReport => {
  const stored: Storable<RunReport> = report;
  return stored;
};
