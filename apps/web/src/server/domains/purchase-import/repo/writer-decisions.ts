import { plainDate } from "@cubby/schemas/base-entity";
import { classificationFieldRefusal } from "@cubby/schemas/classification-field-policy";
import type { ExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import { GTIN_KIND, GTIN_SOURCE } from "@cubby/schemas/external-id";
import type {
  ExtractedPurchaseLine,
  ImportWriterInput,
} from "@cubby/schemas/purchase-import";

import { householdLocalDate } from "~/lib/household-date";
import { wasm } from "~/lib/wasm";
import { amazonAsin } from "~/server/domains/product/repo/amazon-asin";
import type { ExternalIdPair } from "~/server/domains/product/repo/find-by-external-ids";
import { manufacturerPartRequests } from "~/server/domains/purchase-import/repo/manufacturer-identity";

const PURCHASE_EXTERNAL_ID_KIND = "retailer_sku" as const;

/**
 * Preserve a printed calendar day; an instant uses the household-local day.
 * Evidence without a date preserves an existing date or leaves it unknown.
 */
export const purchaseDateFor = (
  orderedAt: string | null,
  existingDate: string | null,
): string | null => {
  if (orderedAt)
    return plainDate.safeParse(orderedAt).success
      ? orderedAt
      : householdLocalDate(new Date(orderedAt));
  if (existingDate) return existingDate;
  return null;
};

/**
 * Deterministic semantic projection shared by the writer and validation.
 * It deliberately excludes evidence bytes and mutable source-claim state.
 */
export function buildPurchaseImportPlan(
  extraction: ImportWriterInput["extraction"],
) {
  const candidate = extraction.candidate;
  const writeBlockReason = !candidate
    ? "unreadable"
    : candidate.currency === null
      ? "missing_currency"
      : candidate.orderedAt === null &&
          (candidate.lines.some((line) => line.amount !== 0) ||
            (extraction.status === "needs_review" &&
              extraction.reason === "unpriced_itemization"))
        ? "missing_date"
        : candidate.printedGrandTotal === null
          ? "missing_total"
          : candidate.currency !== "USD"
            ? "foreign_currency"
            : extraction.status === "needs_review" &&
                [
                  "sum_mismatch",
                  "unpriced_itemization",
                  "foreign_currency",
                  "missing_total",
                ].includes(extraction.reason)
              ? extraction.reason
              : null;
  return {
    orderId: candidate?.orderId ?? null,
    currency: candidate?.currency ?? null,
    statedTotal: candidate?.printedGrandTotal ?? null,
    writeBlockReason,
    lines: (candidate?.lines ?? []).map((line) => ({
      title: line.title,
      amount: line.amount,
      lineKind: line.lineKind,
      quantity: line.quantity ?? null,
    })),
  };
}

export const lineIdentifiers = (
  line: Pick<ExtractedPurchaseLine, "productUrl" | "sku">,
) => {
  const asin = amazonAsin(line.productUrl);
  return [
    ...(line.sku
      ? [{ kind: PURCHASE_EXTERNAL_ID_KIND, externalId: line.sku }]
      : []),
    ...(asin ? [{ kind: "asin" as const, externalId: asin }] : []),
  ];
};

/** Every exact identifier a line can share with a Product; prepare flags and commit refuses the same set. */
export const lineIdentifierRequests = (
  source: string,
  line: Pick<ExtractedPurchaseLine, "title" | "productUrl" | "sku">,
): ExternalIdPair[] => {
  const ids = [
    ...new Set(
      [line.sku, amazonAsin(line.productUrl)].filter((id): id is string =>
        Boolean(id),
      ),
    ),
  ];
  return [
    ...ids.flatMap((externalId) => [
      { source, externalId, kind: "retailer_sku" as const },
      { source, externalId, kind: "asin" as const },
    ]),
    ...ids.flatMap<ExternalIdPair>((id) => {
      const gtin = wasm.scan_code_gtin14(id);
      return gtin
        ? [{ source: GTIN_SOURCE, externalId: gtin, kind: GTIN_KIND }]
        : [];
    }),
    ...manufacturerPartRequests(line),
  ];
};

/** The same vendor SKU in one order must resolve to one Product decision. */
export const lineExternalIdentity = (
  line: Pick<ExtractedPurchaseLine, "productUrl" | "sku">,
  source: string,
): string | null => {
  const [first] = lineIdentifiers(line);
  return first ? `${source}:${first.kind}:${first.externalId}` : null;
};

export type LineIdentityDecision = {
  productId: string | null;
  promote: boolean;
  /**
   * The resolution affirmatively said this line is not a stocked item
   * (`expense_only`); distinct from a line left without a Product for lack of
   * identity.
   */
  expenseOnly?: boolean;
  variantDoubt: boolean;
  unresolvedReason: string | null;
  probability: number;
  lineKind: ExpenseLineKind;
  kitKind: "kit_with_components" | "single" | "n_pack";
  reversalKind: "return" | "concession" | "cancellation" | "replacement" | null;
  /** Exact name matches a sourced Distinct-from decision cleared for creation. */
  distinctFrom?: ExplicitDistinctFrom[];
};

type ExplicitProductResolution = NonNullable<
  ImportWriterInput["productResolutions"]
>[number];
export type ExplicitDistinctFrom = NonNullable<
  Extract<ExplicitProductResolution, { kind: "new" }>["distinctFrom"]
>[number];

/**
 * Resolve the explicit `purchase_import.commit` path's caller-supplied
 * resolutions into the same shape `decideLineIdentities` produces. Adjustment
 * lines (tax/shipping/discount/etc.) never carry a Product, so the resolution
 * roster the MCP layer builds is keyed to principal lines only — a missing
 * resolution is only an error when the line is principal.
 */
export async function explicitLineDecisions(
  lines: readonly ExtractedPurchaseLine[],
  resolutions: readonly ExplicitProductResolution[],
  resolveReversal: (
    index: number,
    line: ExtractedPurchaseLine,
  ) => Promise<{ selectedIndex: number | null }>,
): Promise<LineIdentityDecision[]> {
  const decisions: LineIdentityDecision[] = [];
  for (const [index, line] of lines.entries()) {
    if (
      classificationFieldRefusal(
        "expense",
        { lineKind: line.lineKind, lineBasis: "item_line" },
        "productId",
      ) !== null
    ) {
      decisions.push({
        productId: null,
        promote: false,
        variantDoubt: false,
        probability: 1,
        unresolvedReason: null,
        lineKind: line.lineKind,
        kitKind: "single",
        reversalKind: null,
      });
      continue;
    }
    const resolution = resolutions.find((item) => item.lineIndex === index);
    if (!resolution)
      throw new Error(`Missing product resolution for line ${index}`);
    const reversal =
      line.amount !== null && line.amount < 0
        ? await resolveReversal(index, line)
        : null;
    const reversalKind = reversal
      ? ((["return", "concession", "cancellation", "replacement"] as const)[
          reversal.selectedIndex ?? 1
        ] ?? "concession")
      : null;
    decisions.push({
      productId: resolution.kind === "existing" ? resolution.productId : null,
      promote: resolution.kind === "new",
      expenseOnly: resolution.kind === "expense_only",
      variantDoubt: false,
      unresolvedReason:
        resolution.kind === "unresolved" ? resolution.reason : null,
      probability: 1,
      lineKind: line.lineKind,
      kitKind: "single",
      reversalKind,
      distinctFrom:
        resolution.kind === "new" ? resolution.distinctFrom : undefined,
    });
  }
  return decisions;
}
