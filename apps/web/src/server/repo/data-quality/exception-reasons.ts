import {
  type DataCheck,
  type DataExceptionReason,
  dataCheckEntity,
  dataCheckExemptible,
  dataQualityExceptionEntities,
} from "@cubby/schemas/data-quality";

/** The one source of the reasons each exemptible check accepts. */
const EXCEPTION_REASONS = {
  order_id: ["not_issued", "unavailable"],
  stated_total: ["not_issued", "unavailable"],
  primary_document: ["not_issued", "unavailable", "history_expired"],
  empty_expenses: ["unavailable", "history_expired"],
  purchase_itemization: ["unavailable", "history_expired"],
  financial_transaction_document: [
    "not_issued",
    "unavailable",
    "history_expired",
  ],
  financial_transaction_itemization: ["unavailable", "history_expired"],
  financial_transaction_products: ["unavailable", "insufficient_detail"],
  settlement_reference: ["not_applicable", "insufficient_detail"],
  // Settlement evidence and the expense ledger can both be correct while a
  // source leaves a small residual. This is never a tolerance: it requires a
  // reasoned, evidence-bound exception and reopens on any evidence change.
  settlement_mismatch: ["expected_mismatch"],
  paperwork_mismatch: ["expected_mismatch"],
  amazon_asin: ["unavailable", "insufficient_detail"],
  // A check absent from this map admits NO reason at all, so its gap can never
  // be closed even when the fact provably does not exist. The three identity
  // checks below sat in that state: a kit component the manufacturer never
  // catalogued separately (for example, an unbranded carrying bag) has no model
  // number to record, and no exception could say so.
  product_manufacturer: ["not_applicable", "unavailable"],
  product_category: ["not_applicable", "insufficient_detail"],
  product_model: ["not_issued", "unavailable"],
  product_external_id: ["not_issued", "unavailable"],
  // `unavailable` is the common one and the reason this check earns its keep:
  // a discontinued item whose listings are all retired has NO canonical asset,
  // and substituting a neighbouring generation is worse than no image because
  // the swap is undetectable later. Before this check existed that finding had
  // nowhere to live but free-text notes, so every sweep re-researched the same
  // dead ends. `not_applicable` covers a `misc:` bucket row, which is a
  // stocked pseudo-product that no single photograph describes.
  product_image: ["unavailable", "not_applicable"],
  // A regional or defunct vendor can have no mark or site worth recording.
  vendor_logo: ["unavailable"],
  vendor_website: ["unavailable", "not_applicable"],
  vendor_order_evidence: ["not_applicable"],
  // A price that enrichment could not find stays unknowable; a freebie or
  // sample has none to find.
  product_price: ["unavailable", "not_applicable"],
  // Gifts and previously owned items are already out of scope via
  // `acquisitionOrigin`; this covers stock acquired without a receipt, such as
  // a market stall or hand-me-down recorded under another origin.
  product_unpurchased: ["not_issued", "unavailable"],
  purchase_date: ["unavailable"],
  unpriced_expense: ["unavailable", "history_expired"],
  expense_cost: ["unavailable", "history_expired"],
  expense_product_resolution: ["unavailable", "insufficient_detail"],
  // Statement-sourced facts that no source states: a blank merchant, or a
  // booking that cannot be allocated from the detail the statement carries.
  financial_transaction_merchant: ["unavailable"],
  financial_transaction_allocation: ["unavailable", "insufficient_detail"],
  financial_transaction_booking: ["unavailable", "insufficient_detail"],
  // Checks whose gap is closed by classifying the record (category origin,
  // receipt expectation, transaction kind, duplicate ids) declare
  // `exceptions: "forbidden"` instead of carrying a reason list.
} satisfies Partial<Record<DataCheck, readonly DataExceptionReason[]>>;

export const exceptionReasonsFor = (
  check: DataCheck,
): readonly DataExceptionReason[] =>
  dataCheckExemptible[check] &&
  dataQualityExceptionEntities[dataCheckEntity[check]]
    ? (Object.entries(EXCEPTION_REASONS).find(([key]) => key === check)?.[1] ??
      [])
    : [];
