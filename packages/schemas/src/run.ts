import { z } from "zod";

import {
  generatedRunFieldSchemas,
  generatedRunFilterFields,
} from "./generated/entity-field-schemas.run.gen";
import { generatedEntitySort } from "./generated/entity-sort.gen";
import {
  productShortcode,
  purchaseShortcode,
  runShortcode,
} from "./identifiers";
import {
  createPaginatedResponseSchema,
  createSortPaginationFields,
} from "./pagination";

export const runOut = z.object(generatedRunFieldSchemas.read);
export type RunOut = z.infer<typeof runOut>;
export const runListResponse = createPaginatedResponseSchema(runOut);
export const runFilterFields = {
  ...generatedRunFilterFields,
};
export const runFilters = z.object(runFilterFields);
export type RunFilters = z.infer<typeof runFilters>;

/**
 * The web Runs list read. A Run has no create/update contract, so it sits
 * outside the kernel list roster and its generated index reads this instead.
 */
export const runBrowserListInput = z.object({
  filters: runFilters,
  ...createSortPaginationFields({
    sortableFields: generatedEntitySort.run.fields,
    defaultSort: generatedEntitySort.run.default,
  }),
});

export const targetedImportPurpose = z.enum([
  "purchase_validation",
  "product_enrichment",
]);
export type TargetedImportPurpose = z.infer<typeof targetedImportPurpose>;

/**
 * Targeted import launch input. Exported (and named) here, not inline in
 * `contracts/run.contract.ts`, because the OpenAPI generator only assigns
 * component names to a discriminated union's members when the union itself
 * is a named export of a scanned schema module (see
 * `scripts/generator/http-api/schema-names.ts`): an inline union in a
 * contract file never gets its members visited by `nameUnionMembers`, so
 * `discriminator.mapping` has nothing to point `$ref` at. Entity targets use
 * public shortcodes; an opaque source-claim id is resolved again against the
 * actor's own claims.
 */
export const targetedImportStartInput = z
  .discriminatedUnion("purpose", [
    z
      .object({
        purpose: z.literal("purchase_validation"),
        purchaseId: purchaseShortcode,
        sourceId: z.string().min(1).nullable(),
      })
      .meta({ id: "TargetedImportStartInputPurchaseValidation" }),
    z
      .object({
        purpose: z.literal("product_enrichment"),
        targets: z
          .array(
            z.object({
              productId: productShortcode,
              sourceId: z.string().min(1).nullable(),
              vendorAccountId: z.string().min(1).nullable(),
            }),
          )
          .min(1),
      })
      .meta({ id: "TargetedImportStartInputProductEnrichment" }),
  ])
  .meta({ id: "TargetedImportStartInput" });
export type TargetedImportStartInput = z.input<typeof targetedImportStartInput>;

export const targetedImportStartOutput = z.object({
  runs: z.array(
    z.object({
      created: z.boolean(),
      run: z
        .object({
          id: runShortcode,
          status: z.string().min(1),
          purpose: targetedImportPurpose,
          dispatchEventId: z.string().nullable(),
        })
        .nullable(),
      blockingRun: z
        .object({ id: runShortcode, status: z.string().min(1) })
        .nullable(),
    }),
  ),
});
export type TargetedImportStartOutput = z.infer<
  typeof targetedImportStartOutput
>;
