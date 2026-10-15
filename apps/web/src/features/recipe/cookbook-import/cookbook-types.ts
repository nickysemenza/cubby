import type { Cookbook, RunReport } from "@cubby/recipebridge/cookbook";
import { freshCookbookRunReportSchema } from "@cubby/schemas/cookbook";
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
 * The crate's book tree and stored zod schema describe the same JSON, but
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
 * field name and every leaf type in the book tree still has to match. The
 * separate report conversion validates and normalizes its accounting shape.
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
  return freshCookbookRunReportSchema.parse(report);
};
