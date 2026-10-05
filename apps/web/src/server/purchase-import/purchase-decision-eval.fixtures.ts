import type { ExpenseLineKind } from "@cubby/schemas/expense-line-kind";

import { formatCount, formatCurrency } from "~/lib/number-format";

import type {
  ExpectedDecision,
  ProductDecision,
} from "./purchase-decision-eval.score";

/**
 * Synthetic purchase-decision cases for the live coordinator model eval
 * (`purchase-decision-eval.live-eval.ts`). Each case is one saved order
 * confirmation whose extraction is fixed, so the eval measures the
 * coordinator's decisions — Product identity, line roles, reversals,
 * settlement, and when to stop — not the extractor. Vendors, products,
 * identifiers, and amounts are invented.
 */
type DecisionCatalogProduct = {
  key: string;
  name: string;
  manufacturer?: string;
  model?: string;
  /** A retailer SKU this vendor already recorded for exactly this variant. */
  sku?: string;
};

type DecisionLine = {
  key: string;
  title: string;
  amount: number;
  lineKind: ExpenseLineKind;
  sku?: string;
  /** Units the line prints; principal lines default to 1. */
  quantity?: number;
};

export type DecisionCase = {
  name: string;
  focus:
    | "identity"
    | "line_roles"
    | "reversal"
    | "settlement"
    | "incomplete_evidence";
  orderId: string;
  /** Calendar date the confirmation states, or null when it states none. */
  orderedAt: string | null;
  extraction:
    | { status: "ready" }
    | {
        status: "needs_review";
        reason:
          | "missing_total"
          | "ambiguous_order"
          | "sum_mismatch"
          | "foreign_currency";
        detail: string;
      }
    | { status: "unreadable"; detail: string };
  /** False when the confirmation prints no grand total. */
  printsTotal: boolean;
  /** A printed grand total that differs from the line sum. */
  printedTotal?: number;
  /** Order currency; USD unless stated. */
  currency?: string;
  lines: DecisionLine[];
  catalog: DecisionCatalogProduct[];
  /** Saved card charges the settlement verification can see. */
  charges?: Array<{ key: string; amount: number; date: string }>;
  /** Payment lines the confirmation itself prints; settlement evidence. */
  payments?: Array<{ amount: number; date: string }>;
  /** Another already-imported order from the same vendor. */
  priorOrder?: { orderId: string; total: number; date: string };
  expected: ExpectedDecision;
};

const MERCHANT = "Scenario Outfitters";

const shellCatalog: DecisionCatalogProduct[] = [
  {
    key: "shell-olive-m",
    name: "Trailhead rain shell, Olive, M",
    manufacturer: "Trailhead",
    model: "RS-2020",
    sku: "RS-OLV-M",
  },
  {
    key: "shell-olive-l",
    name: "Trailhead rain shell, Olive, L",
    manufacturer: "Trailhead",
    model: "RS-2020",
    sku: "RS-OLV-L",
  },
];

const line = (
  key: string,
  title: string,
  amount: number,
  lineKind: DecisionLine["lineKind"] = "principal",
  sku?: string,
): DecisionLine => ({ key, title, amount, lineKind, sku });

const written = (
  date: string,
  lines: Array<[DecisionLine, ProductDecision]>,
  allocations: Array<{ transaction: string; amount: number }> = [],
  reviewAcceptable = false,
): ExpectedDecision => ({
  kind: "write",
  lines: lines.map(([entry, product]) => ({
    key: entry.key,
    cost: entry.amount,
    date,
    product,
  })),
  allocations,
  reviewAcceptable,
});

const shellM = line(
  "shell",
  "Trailhead rain shell, Olive, size M",
  64,
  "principal",
  "RS-OLV-M",
);
const tax = (amount: number) => line("tax", "Sales tax", amount, "tax");
const kneeler = line("kneeler", "Fernleaf garden kneeler pad", 18);
const none = { kind: "none" } as const;

export const purchaseDecisionCases: DecisionCase[] = [
  {
    name: "identity-exact-variant-sku",
    focus: "identity",
    orderId: "DEC10001",
    orderedAt: "2026-09-20",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [shellM, tax(5.12)],
    catalog: shellCatalog,
    expected: written("2026-09-20", [
      [shellM, { kind: "existing", product: "shell-olive-m" }],
      [tax(5.12), none],
    ]),
  },
  {
    // The style number is shared by every size; size S is not in the
    // catalog, so it is a new sibling Product, never the M or L.
    name: "identity-shared-style-number",
    focus: "identity",
    orderId: "DEC10002",
    orderedAt: "2026-09-20",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [line("shell", "Trailhead rain shell RS-2020, Olive, size S", 64)],
    catalog: shellCatalog,
    expected: written("2026-09-20", [
      [
        line("shell", "Trailhead rain shell RS-2020, Olive, size S", 64),
        { kind: "new" },
      ],
    ]),
  },
  {
    // No size is stated and two sizes exist: only a human can choose.
    name: "identity-ambiguous-sibling-variants",
    focus: "identity",
    orderId: "DEC10003",
    orderedAt: "2026-09-20",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [line("shell", "Trailhead rain shell RS-2020, Olive", 64)],
    catalog: shellCatalog,
    expected: {
      kind: "review",
      evidence: [{ key: "shell", cost: 64, date: "2026-09-20" }],
    },
  },
  {
    name: "identity-existing-by-exact-name",
    focus: "identity",
    orderId: "DEC10004",
    orderedAt: "2026-09-21",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [line("pot", "Fernleaf ceramic plant pot, 6 in", 22)],
    catalog: [
      {
        key: "pot-6",
        name: "Fernleaf ceramic plant pot, 6 in",
        manufacturer: "Fernleaf",
      },
      {
        key: "pot-8",
        name: "Fernleaf ceramic plant pot, 8 in",
        manufacturer: "Fernleaf",
      },
    ],
    expected: written("2026-09-21", [
      [
        line("pot", "Fernleaf ceramic plant pot, 6 in", 22),
        { kind: "existing", product: "pot-6" },
      ],
    ]),
  },
  {
    name: "identity-new-product",
    focus: "identity",
    orderId: "DEC10005",
    orderedAt: "2026-09-21",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [line("kit", "Copperline drip irrigation starter kit", 41)],
    catalog: [{ key: "hose", name: "Copperline garden hose, 50 ft" }],
    expected: written("2026-09-21", [
      [
        line("kit", "Copperline drip irrigation starter kit", 41),
        { kind: "new" },
      ],
    ]),
  },
  {
    name: "line-roles-adjustments",
    focus: "line_roles",
    orderId: "DEC20001",
    orderedAt: "2026-09-22",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [
      line("pot", "Fernleaf ceramic plant pot, 6 in", 22),
      line("shipping", "Standard shipping", 6.99, "shipping"),
      line("discount", "Welcome discount", -5, "discount"),
      tax(1.92),
    ],
    catalog: [
      {
        key: "pot-6",
        name: "Fernleaf ceramic plant pot, 6 in",
        manufacturer: "Fernleaf",
      },
    ],
    expected: written("2026-09-22", [
      [
        line("pot", "Fernleaf ceramic plant pot, 6 in", 22),
        { kind: "existing", product: "pot-6" },
      ],
      [line("shipping", "Standard shipping", 6.99, "shipping"), none],
      [line("discount", "Welcome discount", -5, "discount"), none],
      [tax(1.92), none],
    ]),
  },
  {
    // An exchange: the credit reverses the saw already owned (exact SKU),
    // and the replacement shears are a new Product.
    name: "reversal-exchange-credit",
    focus: "reversal",
    orderId: "DEC30001",
    orderedAt: "2026-09-23",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [
      line(
        "saw-credit",
        "Return credit: Synthetic pruning saw",
        -9,
        "principal",
        "SAW-30",
      ),
      line("shears", "Bypass pruning shears", 14),
    ],
    catalog: [{ key: "saw", name: "Synthetic pruning saw", sku: "SAW-30" }],
    expected: written("2026-09-23", [
      [
        line(
          "saw-credit",
          "Return credit: Synthetic pruning saw",
          -9,
          "principal",
          "SAW-30",
        ),
        { kind: "existing", product: "saw" },
      ],
      [line("shears", "Bypass pruning shears", 14), { kind: "new" }],
    ]),
  },
  {
    name: "settlement-unique-charge",
    focus: "settlement",
    orderId: "DEC40001",
    orderedAt: "2026-09-21",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [kneeler, tax(1.44)],
    catalog: [],
    // The printed payment line is the evidence; an amount match alone would
    // only be a review candidate.
    payments: [{ amount: 19.44, date: "2026-09-22" }],
    charges: [
      { key: "card-a", amount: 19.44, date: "2026-09-22" },
      { key: "card-b", amount: 12, date: "2026-09-22" },
    ],
    expected: written(
      "2026-09-21",
      [
        [kneeler, { kind: "new" }],
        [tax(1.44), none],
      ],
      [{ transaction: "card-a", amount: 19.44 }],
    ),
  },
  {
    // Two equal charges on one day: coincidence, not a unique settlement.
    name: "settlement-duplicate-amounts",
    focus: "settlement",
    orderId: "DEC40002",
    orderedAt: "2026-09-21",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [kneeler, tax(1.44)],
    catalog: [],
    charges: [
      { key: "card-a", amount: 19.44, date: "2026-09-22" },
      { key: "card-b", amount: 19.44, date: "2026-09-22" },
    ],
    expected: written(
      "2026-09-21",
      [
        [kneeler, { kind: "new" }],
        [tax(1.44), none],
      ],
      [],
      true,
    ),
  },
  {
    // One charge equals this order plus an earlier one: a grouped
    // settlement needs each order's own payment evidence, so a sum is only
    // a proposal.
    name: "settlement-grouped-sum-coincidence",
    focus: "settlement",
    orderId: "DEC40003",
    orderedAt: "2026-09-21",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [kneeler, tax(1.44)],
    catalog: [],
    priorOrder: { orderId: "DEC40000", total: 10, date: "2026-09-21" },
    charges: [{ key: "card-g", amount: 29.44, date: "2026-09-22" }],
    expected: written(
      "2026-09-21",
      [
        [kneeler, { kind: "new" }],
        [tax(1.44), none],
      ],
      [],
      true,
    ),
  },
  {
    name: "incomplete-missing-date-and-total",
    focus: "incomplete_evidence",
    orderId: "DEC50001",
    orderedAt: null,
    extraction: {
      status: "needs_review",
      reason: "missing_total",
      detail: "The confirmation prints no order date or grand total.",
    },
    printsTotal: false,
    lines: [line("reel", "Copperline hose reel", 39)],
    catalog: [],
    expected: {
      kind: "review",
      evidence: [{ key: "reel", cost: 39, date: null }],
    },
  },
  {
    name: "incomplete-no-itemization",
    focus: "incomplete_evidence",
    orderId: "DEC50002",
    orderedAt: "2026-09-24",
    extraction: {
      status: "unreadable",
      detail: "The confirmation names the order but lists no items or total.",
    },
    printsTotal: false,
    lines: [],
    catalog: [],
    expected: { kind: "review", evidence: [] },
  },
  {
    // The exact-variant SKU decides identity even when the title is terse.
    name: "identity-sku-abbreviated-title",
    focus: "identity",
    orderId: "DEC10006",
    orderedAt: "2026-09-20",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [line("shell", "TH rain shell olv M", 64, "principal", "RS-OLV-M")],
    catalog: shellCatalog,
    expected: written("2026-09-20", [
      [
        line("shell", "TH rain shell olv M", 64, "principal", "RS-OLV-M"),
        { kind: "existing", product: "shell-olive-m" },
      ],
    ]),
  },
  {
    // The title says M and the SKU belongs to L: conflicting identity
    // evidence is a human's call.
    name: "identity-sku-conflicts-title",
    focus: "identity",
    orderId: "DEC10007",
    orderedAt: "2026-09-20",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [
      line(
        "shell",
        "Trailhead rain shell, Olive, size M",
        64,
        "principal",
        "RS-OLV-L",
      ),
    ],
    catalog: shellCatalog,
    expected: {
      kind: "review",
      evidence: [{ key: "shell", cost: 64, date: "2026-09-20" }],
    },
  },
  {
    // Same style number, a color the catalog lacks: a new sibling.
    name: "identity-new-color-sibling",
    focus: "identity",
    orderId: "DEC10008",
    orderedAt: "2026-09-20",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [line("shell", "Trailhead rain shell RS-2020, Navy, size M", 64)],
    catalog: shellCatalog,
    expected: written("2026-09-20", [
      [
        line("shell", "Trailhead rain shell RS-2020, Navy, size M", 64),
        { kind: "new" },
      ],
    ]),
  },
  {
    // The same kind of item from another brand is not the catalog Product.
    name: "identity-different-brand",
    focus: "identity",
    orderId: "DEC10009",
    orderedAt: "2026-09-21",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [line("pot", "Brightclay ceramic plant pot, 6 in", 22)],
    catalog: [
      {
        key: "pot-6",
        name: "Fernleaf ceramic plant pot, 6 in",
        manufacturer: "Fernleaf",
      },
    ],
    expected: written("2026-09-21", [
      [line("pot", "Brightclay ceramic plant pot, 6 in", 22), { kind: "new" }],
    ]),
  },
  {
    // A different pack size is a different sellable variant.
    name: "identity-pack-size-variant",
    focus: "identity",
    orderId: "DEC10010",
    orderedAt: "2026-09-21",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [line("washers", "Copperline hose washers, 25-pack", 7)],
    catalog: [
      {
        key: "washers-10",
        name: "Copperline hose washers, 10-pack",
        manufacturer: "Copperline",
      },
    ],
    expected: written("2026-09-21", [
      [line("washers", "Copperline hose washers, 25-pack", 7), { kind: "new" }],
    ]),
  },
  {
    name: "identity-mixed-existing-and-new",
    focus: "identity",
    orderId: "DEC10011",
    orderedAt: "2026-09-22",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [shellM, kneeler, tax(6.56)],
    catalog: shellCatalog,
    expected: written("2026-09-22", [
      [shellM, { kind: "existing", product: "shell-olive-m" }],
      [kneeler, { kind: "new" }],
      [tax(6.56), none],
    ]),
  },
  {
    // Only punctuation and casing differ: reuse, never duplicate.
    name: "identity-reformatted-name",
    focus: "identity",
    orderId: "DEC10012",
    orderedAt: "2026-09-22",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [line("pot", "FERNLEAF Ceramic Plant Pot (6 in.)", 22)],
    catalog: [
      {
        key: "pot-6",
        name: "Fernleaf ceramic plant pot, 6 in",
        manufacturer: "Fernleaf",
      },
      {
        key: "pot-8",
        name: "Fernleaf ceramic plant pot, 8 in",
        manufacturer: "Fernleaf",
      },
    ],
    expected: written("2026-09-22", [
      [
        line("pot", "FERNLEAF Ceramic Plant Pot (6 in.)", 22),
        { kind: "existing", product: "pot-6" },
      ],
    ]),
  },
  {
    name: "line-roles-fee-and-tip",
    focus: "line_roles",
    orderId: "DEC20002",
    orderedAt: "2026-09-22",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [
      kneeler,
      line("fee", "Small order fee", 2.5, "fee"),
      line("tip", "Courier tip", 3, "tip"),
    ],
    catalog: [],
    expected: written("2026-09-22", [
      [kneeler, { kind: "new" }],
      [line("fee", "Small order fee", 2.5, "fee"), none],
      [line("tip", "Courier tip", 3, "tip"), none],
    ]),
  },
  {
    // A shipping charge cancelled by a free-shipping discount: both lines
    // are kept, neither carries a Product.
    name: "line-roles-free-shipping-offset",
    focus: "line_roles",
    orderId: "DEC20003",
    orderedAt: "2026-09-22",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [
      kneeler,
      line("shipping", "Ground shipping", 5.99, "shipping"),
      line("free-shipping", "Free shipping promotion", -5.99, "discount"),
    ],
    catalog: [],
    expected: written("2026-09-22", [
      [kneeler, { kind: "new" }],
      [line("shipping", "Ground shipping", 5.99, "shipping"), none],
      [
        line("free-shipping", "Free shipping promotion", -5.99, "discount"),
        none,
      ],
    ]),
  },
  {
    // Two units on one line: one Product, the line's printed extended cost.
    name: "line-roles-quantity-two",
    focus: "line_roles",
    orderId: "DEC20004",
    orderedAt: "2026-09-23",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [
      { ...line("kneelers", "Fernleaf garden kneeler pad", 36), quantity: 2 },
    ],
    catalog: [],
    expected: written("2026-09-23", [
      [line("kneelers", "Fernleaf garden kneeler pad", 36), { kind: "new" }],
    ]),
  },
  {
    name: "line-roles-split-taxes",
    focus: "line_roles",
    orderId: "DEC20005",
    orderedAt: "2026-09-23",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [
      line("pot", "Fernleaf ceramic plant pot, 6 in", 22),
      line("state-tax", "State sales tax", 1.32, "tax"),
      line("county-tax", "County sales tax", 0.44, "tax"),
    ],
    catalog: [
      {
        key: "pot-6",
        name: "Fernleaf ceramic plant pot, 6 in",
        manufacturer: "Fernleaf",
      },
    ],
    expected: written("2026-09-23", [
      [
        line("pot", "Fernleaf ceramic plant pot, 6 in", 22),
        { kind: "existing", product: "pot-6" },
      ],
      [line("state-tax", "State sales tax", 1.32, "tax"), none],
      [line("county-tax", "County sales tax", 0.44, "tax"), none],
    ]),
  },
  {
    // A refund-only order: the credit reverses the exact owned variant and
    // the tax refund carries no Product.
    name: "reversal-full-return",
    focus: "reversal",
    orderId: "DEC30002",
    orderedAt: "2026-09-24",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [
      line(
        "shell-credit",
        "Return credit: Trailhead rain shell, Olive, size M",
        -64,
        "principal",
        "RS-OLV-M",
      ),
      line("tax-credit", "Sales tax refund", -5.12, "tax"),
    ],
    catalog: shellCatalog,
    expected: written("2026-09-24", [
      [
        line(
          "shell-credit",
          "Return credit: Trailhead rain shell, Olive, size M",
          -64,
          "principal",
          "RS-OLV-M",
        ),
        { kind: "existing", product: "shell-olive-m" },
      ],
      [line("tax-credit", "Sales tax refund", -5.12, "tax"), none],
    ]),
  },
  {
    name: "reversal-price-adjustment",
    focus: "reversal",
    orderId: "DEC30003",
    orderedAt: "2026-09-24",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [
      line("pot", "Fernleaf ceramic plant pot, 6 in", 22),
      line("adjustment", "Price adjustment", -3, "discount"),
    ],
    catalog: [
      {
        key: "pot-6",
        name: "Fernleaf ceramic plant pot, 6 in",
        manufacturer: "Fernleaf",
      },
    ],
    expected: written("2026-09-24", [
      [
        line("pot", "Fernleaf ceramic plant pot, 6 in", 22),
        { kind: "existing", product: "pot-6" },
      ],
      [line("adjustment", "Price adjustment", -3, "discount"), none],
    ]),
  },
  {
    name: "reversal-return-with-restocking-fee",
    focus: "reversal",
    orderId: "DEC30004",
    orderedAt: "2026-09-24",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [
      line(
        "saw-credit",
        "Return credit: Synthetic pruning saw",
        -9,
        "principal",
        "SAW-30",
      ),
      line("restocking", "Restocking fee", 1.5, "fee"),
    ],
    catalog: [{ key: "saw", name: "Synthetic pruning saw", sku: "SAW-30" }],
    expected: written("2026-09-24", [
      [
        line(
          "saw-credit",
          "Return credit: Synthetic pruning saw",
          -9,
          "principal",
          "SAW-30",
        ),
        { kind: "existing", product: "saw" },
      ],
      [line("restocking", "Restocking fee", 1.5, "fee"), none],
    ]),
  },
  {
    // Two printed payments match two charges; a third charge equal to the
    // order total is a coincidence the printed evidence rules out.
    name: "settlement-split-payment",
    focus: "settlement",
    orderId: "DEC40004",
    orderedAt: "2026-09-21",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [kneeler, tax(1.44)],
    catalog: [],
    payments: [
      { amount: 10, date: "2026-09-22" },
      { amount: 9.44, date: "2026-09-22" },
    ],
    charges: [
      { key: "card-a", amount: 10, date: "2026-09-22" },
      { key: "card-b", amount: 9.44, date: "2026-09-22" },
      { key: "card-c", amount: 19.44, date: "2026-09-22" },
    ],
    expected: written(
      "2026-09-21",
      [
        [kneeler, { kind: "new" }],
        [tax(1.44), none],
      ],
      [
        { transaction: "card-a", amount: 10 },
        { transaction: "card-b", amount: 9.44 },
      ],
    ),
  },
  {
    // The only charge is one cent off the printed payment: no settlement.
    name: "settlement-amount-off-by-cent",
    focus: "settlement",
    orderId: "DEC40005",
    orderedAt: "2026-09-21",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [kneeler, tax(1.44)],
    catalog: [],
    payments: [{ amount: 19.44, date: "2026-09-22" }],
    charges: [{ key: "card-a", amount: 19.45, date: "2026-09-22" }],
    expected: written(
      "2026-09-21",
      [
        [kneeler, { kind: "new" }],
        [tax(1.44), none],
      ],
      [],
      true,
    ),
  },
  {
    // Two equal charges, but only one on the printed payment date; the
    // other predates the order.
    name: "settlement-printed-date-disambiguates",
    focus: "settlement",
    orderId: "DEC40006",
    orderedAt: "2026-09-21",
    extraction: { status: "ready" },
    printsTotal: true,
    lines: [kneeler, tax(1.44)],
    catalog: [],
    payments: [{ amount: 19.44, date: "2026-09-22" }],
    charges: [
      { key: "card-a", amount: 19.44, date: "2026-09-22" },
      { key: "card-b", amount: 19.44, date: "2026-08-30" },
    ],
    expected: written(
      "2026-09-21",
      [
        [kneeler, { kind: "new" }],
        [tax(1.44), none],
      ],
      [{ transaction: "card-a", amount: 19.44 }],
    ),
  },
  {
    name: "incomplete-ambiguous-order",
    focus: "incomplete_evidence",
    orderId: "DEC50003",
    orderedAt: "2026-09-24",
    extraction: {
      status: "needs_review",
      reason: "ambiguous_order",
      detail: "The message lists two order numbers and one set of items.",
    },
    printsTotal: true,
    lines: [line("reel", "Copperline hose reel", 39)],
    catalog: [],
    expected: {
      kind: "review",
      evidence: [{ key: "reel", cost: 39, date: "2026-09-24" }],
    },
  },
  {
    // The printed total disagrees with the lines: a line is missing or
    // misread, so nothing may be completed.
    name: "incomplete-sum-mismatch",
    focus: "incomplete_evidence",
    orderId: "DEC50004",
    orderedAt: "2026-09-24",
    extraction: {
      status: "needs_review",
      reason: "sum_mismatch",
      detail: "Lines sum to 23.76 but the printed grand total is 30.76.",
    },
    printsTotal: true,
    printedTotal: 30.76,
    lines: [line("pot", "Fernleaf ceramic plant pot, 6 in", 22), tax(1.76)],
    catalog: [],
    expected: {
      kind: "review",
      evidence: [
        { key: "pot", cost: 22, date: "2026-09-24" },
        { key: "tax", cost: 1.76, date: "2026-09-24" },
      ],
    },
  },
  {
    name: "incomplete-foreign-currency",
    focus: "incomplete_evidence",
    orderId: "DEC50005",
    orderedAt: "2026-09-24",
    extraction: {
      status: "needs_review",
      reason: "foreign_currency",
      detail: "The order is priced in EUR.",
    },
    printsTotal: true,
    currency: "EUR",
    lines: [line("reel", "Copperline hose reel", 36)],
    catalog: [],
    expected: {
      kind: "review",
      evidence: [{ key: "reel", cost: 36, date: "2026-09-24" }],
    },
  },
];

const money = (amount: number, currency = "USD") =>
  currency === "USD"
    ? formatCurrency(amount)
    : `${currency} ${formatCount(amount, 2)}`;

const printedTotal = (decision: DecisionCase) =>
  decision.printedTotal ??
  Math.round(
    decision.lines.reduce((sum, entry) => sum + entry.amount, 0) * 100,
  ) / 100;

/** The saved confirmation body the coordinator may read. */
export function decisionMailBody(decision: DecisionCase) {
  const currency = decision.currency ?? "USD";
  return [
    `${MERCHANT} order ${decision.orderId}`,
    decision.orderedAt ? `Placed ${decision.orderedAt}` : null,
    ...decision.lines.map(
      (entry) =>
        `${entry.title}${entry.sku ? ` (SKU ${entry.sku})` : ""}${entry.quantity && entry.quantity > 1 ? ` x${entry.quantity}` : ""} ${money(entry.amount, currency)}`,
    ),
    decision.printsTotal
      ? `Order total ${money(printedTotal(decision), currency)} ${currency}`
      : null,
    ...(decision.payments ?? []).map(
      (payment) =>
        `Charged ${money(payment.amount, currency)} on ${payment.date}`,
    ),
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
}

/** The extractor's fixed wire output for the case. */
export function decisionExtraction(decision: DecisionCase) {
  const candidate =
    decision.extraction.status === "unreadable"
      ? null
      : {
          orderId: decision.orderId,
          orderedAt: decision.orderedAt
            ? `${decision.orderedAt}T12:00:00.000Z`
            : null,
          merchant: MERCHANT,
          currency: decision.currency ?? "USD",
          printedGrandTotal: decision.printsTotal
            ? printedTotal(decision)
            : null,
          lines: decision.lines.map((entry) => ({
            title: entry.title,
            amount: entry.amount,
            lineKind: entry.lineKind,
            quantity:
              entry.quantity ?? (entry.lineKind === "principal" ? 1 : null),
            productUrl: null,
            imageUrl: null,
            sku: entry.sku ?? null,
            seller: null,
          })),
          payments: (decision.payments ?? []).map((payment) => ({
            amount: payment.amount,
            chargedAt: `${payment.date}T12:00:00.000Z`,
            cardLastFour: null,
            description: null,
          })),
          allShipmentsDelivered: null,
        };
  return {
    status: decision.extraction.status,
    candidate,
    reason:
      decision.extraction.status === "needs_review"
        ? decision.extraction.reason
        : null,
    detail:
      decision.extraction.status === "ready"
        ? null
        : decision.extraction.detail,
  };
}

export const DECISION_MERCHANT = MERCHANT;
