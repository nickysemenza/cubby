import { formatCurrency } from "~/lib/number-format";

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
export type DecisionCatalogProduct = {
  key: string;
  name: string;
  manufacturer?: string;
  model?: string;
  /** A retailer SKU this vendor already recorded for exactly this variant. */
  sku?: string;
};

export type DecisionLine = {
  key: string;
  title: string;
  amount: number;
  lineKind: "principal" | "tax" | "shipping" | "discount";
  sku?: string;
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
        reason: "missing_total" | "ambiguous_order";
        detail: string;
      }
    | { status: "unreadable"; detail: string };
  /** False when the confirmation prints no grand total. */
  printsTotal: boolean;
  lines: DecisionLine[];
  catalog: DecisionCatalogProduct[];
  /** Saved card charges the settlement verification can see. */
  charges?: Array<{ key: string; amount: number; date: string }>;
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
];

const money = (amount: number) => formatCurrency(amount);

/** The saved confirmation body the coordinator may read. */
export function decisionMailBody(decision: DecisionCase) {
  const total = decision.lines.reduce((sum, entry) => sum + entry.amount, 0);
  return [
    `${MERCHANT} order ${decision.orderId}`,
    decision.orderedAt ? `Placed ${decision.orderedAt}` : null,
    ...decision.lines.map(
      (entry) =>
        `${entry.title}${entry.sku ? ` (SKU ${entry.sku})` : ""} ${money(entry.amount)}`,
    ),
    decision.printsTotal ? `Order total ${money(total)} USD` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
}

/** The extractor's fixed wire output for the case. */
export function decisionExtraction(decision: DecisionCase) {
  const total = decision.lines.reduce((sum, entry) => sum + entry.amount, 0);
  const candidate =
    decision.extraction.status === "unreadable"
      ? null
      : {
          orderId: decision.orderId,
          orderedAt: decision.orderedAt
            ? `${decision.orderedAt}T12:00:00.000Z`
            : null,
          merchant: MERCHANT,
          currency: "USD",
          printedGrandTotal: decision.printsTotal
            ? Math.round(total * 100) / 100
            : null,
          lines: decision.lines.map((entry) => ({
            title: entry.title,
            amount: entry.amount,
            lineKind: entry.lineKind,
            quantity: entry.lineKind === "principal" ? 1 : null,
            productUrl: null,
            imageUrl: null,
            sku: entry.sku ?? null,
            seller: null,
          })),
          payments: [],
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
