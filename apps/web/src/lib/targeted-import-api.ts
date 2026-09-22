import { z } from "zod";

import { readJsonOrThrow } from "~/lib/http-error";
import { importRunShortcode } from "~/lib/purchase-import-run-detail";

/**
 * Browser contract for targeted import launch. Entity targets use public
 * shortcodes; an opaque source-claim id is accepted only in a POST body and
 * resolved again at the authenticated server boundary.
 */
export const targetedImportPurpose = z.enum([
  "purchase_validation",
  "product_enrichment",
]);
export type TargetedImportPurpose = z.infer<typeof targetedImportPurpose>;

const targetedImportSource = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.string().min(1),
  fingerprint: z.string().nullable(),
  vendorAccountId: z.string().nullable(),
  vendorAccountLabel: z.string().nullable(),
  usable: z.boolean(),
  reason: z.string().nullable(),
  default: z.boolean(),
});
export type TargetedImportSource = z.infer<typeof targetedImportSource>;

const targetedProductCandidate = z.object({
  productId: z.string().min(1),
  productName: z.string().min(1),
  selected: z.boolean(),
  sourceId: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  vendorAccountId: z.string().nullable(),
  vendorAccountLabel: z.string().nullable(),
  needsAccountChoice: z.boolean(),
  accountChoices: z.array(
    z.object({ id: z.string().min(1), label: z.string().min(1) }),
  ),
  reason: z.string().nullable(),
});
export type TargetedProductCandidate = z.infer<typeof targetedProductCandidate>;

export const targetedImportLaunchResponse = z.object({
  purpose: targetedImportPurpose,
  purchase: z
    .object({
      id: z.string().min(1),
      label: z.string().min(1),
      canValidate: z.boolean(),
      reason: z.string().nullable(),
      sources: z.array(targetedImportSource),
      products: z.array(targetedProductCandidate),
    })
    .nullable(),
  products: z.array(targetedProductCandidate),
});
export type TargetedImportLaunch = z.infer<typeof targetedImportLaunchResponse>;

const targetedImportCreatedRun = z.object({
  id: importRunShortcode,
  status: z.string().min(1),
  purpose: targetedImportPurpose,
  dispatchEventId: z.string().nullable().optional(),
});

export const targetedImportStartResponse = z.object({
  runs: z.array(
    z.object({
      created: z.boolean(),
      run: targetedImportCreatedRun.nullable(),
      blockingRun: z
        .object({ id: importRunShortcode, status: z.string().min(1) })
        .nullable()
        .default(null),
    }),
  ),
});
export type TargetedImportStartResponse = z.infer<
  typeof targetedImportStartResponse
>;

export const purchaseValidationStartInput = z.object({
  purpose: z.literal("purchase_validation"),
  purchaseId: z.string().min(1),
  sourceId: z.string().min(1).nullable(),
});

export const productEnrichmentStartInput = z.object({
  purpose: z.literal("product_enrichment"),
  targets: z
    .array(
      z.object({
        productId: z.string().min(1),
        sourceId: z.string().min(1).nullable(),
        vendorAccountId: z.string().min(1).nullable(),
      }),
    )
    .min(1),
});

export type TargetedImportStartInput =
  | z.infer<typeof purchaseValidationStartInput>
  | z.infer<typeof productEnrichmentStartInput>;

export const targetedImportError = z.object({ error: z.string().min(1) });

export async function loadTargetedImportLaunch(
  purpose: TargetedImportPurpose,
  targetId: string,
): Promise<TargetedImportLaunch> {
  const query = new URLSearchParams({ purpose, targetId });
  const response = await fetch(`/api/import/targeted?${query.toString()}`);
  return readJsonOrThrow(
    response,
    targetedImportLaunchResponse,
    "Import options could not load.",
  );
}

export async function startTargetedImport(
  input: TargetedImportStartInput,
): Promise<TargetedImportStartResponse> {
  const response = await fetch("/api/import/targeted", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readJsonOrThrow(
    response,
    targetedImportStartResponse,
    "Import run could not start.",
    { method: "POST" },
  );
}
