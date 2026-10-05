import type { BrowserCapture } from "@cubby/schemas/purchase-import";
import type { ImportExtractionOutcome } from "@cubby/schemas/purchase-import";
import {
  type RecipeOut,
  recipeOut,
  sectionIngredientOut,
} from "@cubby/schemas/recipe";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";

import { formatCurrency } from "~/lib/number-format";
import type { PurchaseAuditRenderedBatch } from "~/server/agents/purchase-import/prompts";

import type {
  ExpectedAudit,
  ExpectedRecipeFlow,
  ExpectedRepair,
} from "./feature-routing-eval.score";

/**
 * Synthetic cases for the structured-feature routing eval
 * (`feature-routing-eval.live-eval.ts`): purchase-import audit batches,
 * extraction repairs, and recipe-flow plans. Vendors, products, recipes,
 * identifiers, and amounts are invented.
 */
const uuid = (suffix: number) =>
  `00000000-0000-4000-8000-${suffix.toString(16).padStart(12, "0")}`;

// ---------------------------------------------------------------------------
// Audit: one rendered batch per case, with at most one seeded defect.
// ---------------------------------------------------------------------------

type AuditExpense = PurchaseAuditRenderedBatch[number]["expenses"][number];
type AuditProduct = NonNullable<AuditExpense["product"]>;

const product = (
  id: number,
  name: string,
  manufacturer: string | null = null,
  model: string | null = null,
): AuditProduct => ({ id: uuid(id), name, manufacturer, model });

const shellM = product(
  0xb1,
  "Trailhead rain shell, Olive, M",
  "Trailhead",
  "RS-2020",
);
const shellL = product(
  0xb2,
  "Trailhead rain shell, Olive, L",
  "Trailhead",
  "RS-2020",
);
const pot6 = product(0xb3, "Fernleaf ceramic plant pot, 6 in", "Fernleaf");
const saw = product(0xb4, "Synthetic pruning saw");
const shears = product(0xb5, "Bypass pruning shears");
const reel = product(0xb6, "Copperline hose reel", "Copperline");

const expense = (
  id: number,
  name: string,
  amount: number,
  linked: AuditProduct | null,
  lineKind = "principal",
): AuditExpense => ({
  id: uuid(id),
  name,
  amount,
  lineKind,
  quantity: lineKind === "principal" ? 1 : null,
  product: linked,
});

const auditPurchase = (
  id: number,
  orderId: string,
  statedTotal: number,
  expenses: AuditExpense[],
): PurchaseAuditRenderedBatch[number] => ({
  id: uuid(id),
  orderId,
  statedTotal,
  displayLabel: "Scenario Outfitters",
  expenses,
  paymentEvidence: [],
});

export type AuditCase = {
  name: string;
  batch: PurchaseAuditRenderedBatch;
  expected: ExpectedAudit;
};

export const auditCases: AuditCase[] = [
  {
    name: "audit-clean-single",
    batch: [
      auditPurchase(0xa1, "AUD1001", 69.12, [
        expense(0xe1, "Trailhead rain shell, Olive, size M", 64, shellM),
        expense(0xe2, "Sales tax", 5.12, null, "tax"),
      ]),
    ],
    expected: { kind: "clean" },
  },
  {
    name: "audit-clean-adjustments",
    batch: [
      auditPurchase(0xa1, "AUD1002", 25.91, [
        expense(0xe1, "Fernleaf ceramic plant pot, 6 in", 22, pot6),
        expense(0xe2, "Standard shipping", 6.99, null, "shipping"),
        expense(0xe3, "Welcome discount", -5, null, "discount"),
        expense(0xe4, "Sales tax", 1.92, null, "tax"),
      ]),
    ],
    expected: { kind: "clean" },
  },
  {
    name: "audit-clean-exchange",
    batch: [
      auditPurchase(0xa1, "AUD1003", 5, [
        expense(0xe1, "Return credit: Synthetic pruning saw", -9, saw),
        expense(0xe2, "Bypass pruning shears", 14, shears),
      ]),
    ],
    expected: { kind: "clean" },
  },
  {
    // Two correct sibling variants in one batch: nothing to relink.
    name: "audit-clean-sibling-variants",
    batch: [
      auditPurchase(0xa1, "AUD1004", 64, [
        expense(0xe1, "Trailhead rain shell, Olive, size M", 64, shellM),
      ]),
      auditPurchase(0xa2, "AUD1005", 64, [
        expense(0xe2, "Trailhead rain shell, Olive, size L", 64, shellL),
      ]),
    ],
    expected: { kind: "clean" },
  },
  {
    name: "audit-sum-mismatch",
    batch: [
      auditPurchase(0xa1, "AUD2001", 80, [
        expense(0xe1, "Trailhead rain shell, Olive, size M", 64, shellM),
        expense(0xe2, "Sales tax", 5.12, null, "tax"),
      ]),
    ],
    expected: {
      kind: "defect",
      purchaseId: uuid(0xa1),
      findingKinds: ["sum_mismatch", "missing_line"],
    },
  },
  {
    // The size L line is linked to the M Product; the batch shows the L.
    name: "audit-wrong-variant",
    batch: [
      auditPurchase(0xa1, "AUD2002", 64, [
        expense(0xe1, "Trailhead rain shell, Olive, size L", 64, shellM),
      ]),
      auditPurchase(0xa2, "AUD2003", 64, [
        expense(0xe2, "Trailhead rain shell, Olive, size L", 64, shellL),
      ]),
    ],
    expected: {
      kind: "defect",
      purchaseId: uuid(0xa1),
      findingKinds: ["wrong_product", "variant_doubt"],
      relink: { expenseId: uuid(0xe1), productId: shellL.id },
    },
  },
  {
    name: "audit-duplicate-lines",
    batch: [
      auditPurchase(0xa1, "AUD2004", 39, [
        expense(0xe1, "Copperline hose reel", 39, reel),
        expense(0xe2, "Copperline hose reel", 39, reel),
      ]),
    ],
    expected: {
      kind: "defect",
      purchaseId: uuid(0xa1),
      findingKinds: ["duplicate_lines", "sum_mismatch"],
    },
  },
  {
    name: "audit-product-on-tax-line",
    batch: [
      auditPurchase(0xa1, "AUD2005", 23.76, [
        expense(0xe1, "Fernleaf ceramic plant pot, 6 in", 22, pot6),
        expense(0xe2, "Sales tax", 1.76, pot6, "tax"),
      ]),
    ],
    expected: {
      kind: "defect",
      purchaseId: uuid(0xa1),
      findingKinds: ["wrong_product", "other"],
    },
  },
];

// ---------------------------------------------------------------------------
// Repair: a captured page and the extraction that failed validation.
// ---------------------------------------------------------------------------

type RepairLine = {
  title: string;
  amount: number;
  lineKind: "principal" | "tax" | "shipping" | "discount" | "fee";
};

export type RepairCase = {
  name: string;
  capture: BrowserCapture;
  previous: ImportExtractionOutcome;
  expected: ExpectedRepair;
};

const capture = (orderId: string, text: string): BrowserCapture => ({
  url: `https://shop.example.test/orders/${orderId}`,
  title: `Order ${orderId}`,
  text,
  links: [],
  images: [],
  capturedAt: "2026-09-25T12:00:00.000Z",
});

const previousExtraction = (
  orderId: string,
  printedGrandTotal: number,
  lines: RepairLine[],
): ImportExtractionOutcome => ({
  status: "ready",
  candidate: {
    orderId,
    orderedAt: "2026-09-20T12:00:00.000Z",
    merchant: "Example Tools",
    currency: "USD",
    printedGrandTotal,
    lines,
    payments: [],
    allShipmentsDelivered: null,
  },
});

const repairCase = (
  name: string,
  orderId: string,
  page: { lines: RepairLine[]; printedTotal: number; extra?: string[] },
  previousLines: RepairLine[],
): RepairCase => {
  const sum =
    page.lines.reduce(
      (total, entry) => total + Math.round(entry.amount * 100),
      0,
    ) / 100;
  return {
    name,
    capture: capture(
      orderId,
      [
        `Example Tools — Order ${orderId}`,
        "Order placed September 20, 2026",
        ...page.lines.map(
          (entry) => `${entry.title}    ${formatCurrency(entry.amount)}`,
        ),
        ...(page.extra ?? []),
        `Order total    ${formatCurrency(page.printedTotal)}`,
      ].join("\n"),
    ),
    previous: previousExtraction(orderId, page.printedTotal, previousLines),
    expected: {
      status:
        Math.round(sum * 100) === Math.round(page.printedTotal * 100)
          ? "ready"
          : "needs_review",
      printedTotal: page.printedTotal,
      pageLines: page.lines,
    },
  };
};

const drill: RepairLine = {
  title: "Cordless drill kit",
  amount: 79.95,
  lineKind: "principal",
};
const tax = (amount: number): RepairLine => ({
  title: "Sales tax",
  amount,
  lineKind: "tax",
});

export const repairCases: RepairCase[] = [
  repairCase(
    "repair-missed-shipping",
    "REP1001",
    {
      lines: [drill, { title: "Shipping", amount: 4.05, lineKind: "shipping" }],
      printedTotal: 84,
    },
    [drill],
  ),
  repairCase(
    "repair-misread-amount",
    "REP1002",
    {
      lines: [
        { title: "Garden twine, 200 ft", amount: 12.99, lineKind: "principal" },
        tax(1.04),
      ],
      printedTotal: 14.03,
    },
    [
      { title: "Garden twine, 200 ft", amount: 12.9, lineKind: "principal" },
      tax(1.04),
    ],
  ),
  repairCase(
    "repair-missed-discount",
    "REP1003",
    {
      lines: [
        { title: "Folding garden cart", amount: 50, lineKind: "principal" },
        { title: "Promo SPRING10", amount: -10, lineKind: "discount" },
        tax(3.2),
      ],
      printedTotal: 43.2,
    },
    [
      { title: "Folding garden cart", amount: 50, lineKind: "principal" },
      tax(3.2),
    ],
  ),
  repairCase(
    "repair-duplicated-line",
    "REP1004",
    {
      lines: [
        { title: "Work gloves, L", amount: 20, lineKind: "principal" },
        { title: "Safety glasses", amount: 15, lineKind: "principal" },
      ],
      printedTotal: 35,
    },
    [
      { title: "Work gloves, L", amount: 20, lineKind: "principal" },
      { title: "Work gloves, L", amount: 20, lineKind: "principal" },
      { title: "Safety glasses", amount: 15, lineKind: "principal" },
    ],
  ),
  repairCase(
    "repair-quantity-extended-price",
    "REP1005",
    {
      lines: [
        {
          title: "Hose washers, 10-pack (2 @ $3.50)",
          amount: 7,
          lineKind: "principal",
        },
        tax(0.56),
      ],
      printedTotal: 7.56,
    },
    [
      {
        title: "Hose washers, 10-pack (2 @ $3.50)",
        amount: 3.5,
        lineKind: "principal",
      },
      tax(0.56),
    ],
  ),
  // The page's own lines never reach its printed total: nothing visible can
  // close the gap, so the only safe answer is review.
  repairCase(
    "repair-genuine-mismatch",
    "REP2001",
    {
      lines: [
        { title: "Pruning saw", amount: 30, lineKind: "principal" },
        { title: "Saw sheath", amount: 10, lineKind: "principal" },
      ],
      printedTotal: 45,
    },
    [
      { title: "Pruning saw", amount: 30, lineKind: "principal" },
      { title: "Saw sheath", amount: 10, lineKind: "principal" },
    ],
  ),
  repairCase(
    "repair-genuine-mismatch-with-tax",
    "REP2002",
    {
      lines: [
        { title: "Rain barrel, 50 gal", amount: 89, lineKind: "principal" },
        tax(7.12),
      ],
      printedTotal: 101.12,
      extra: ["Thank you for shopping with Example Tools."],
    },
    [
      { title: "Rain barrel, 50 gal", amount: 89, lineKind: "principal" },
      tax(7.12),
    ],
  ),
];

// ---------------------------------------------------------------------------
// Recipe flow: single-section recipes with known structure.
// ---------------------------------------------------------------------------

const SECTION_ID = uuid(0x5ec);
const at = new Date("2026-01-01");

type RecipeIngredient = { usage: number; name: string; rawLine: string };

function recipeOf(
  code: string,
  name: string,
  ingredients: RecipeIngredient[],
  instructions: string[],
): RecipeOut {
  return recipeOut.parse({
    id: testShortcode("recipe", code),
    name,
    forkedFromRecipeId: null,
    forkedFromRecipeName: null,
    sections: [
      {
        id: SECTION_ID,
        name: null,
        ingredients: ingredients.map((entry, index) =>
          sectionIngredientOut.parse({
            id: uuid(entry.usage),
            type: "ingredient",
            ingredient: {
              id: testShortcode("ingredient", `ING-EV${index}`),
              name: entry.name,
              aliases: [],
              naKinds: [],
              createdAt: at,
              updatedAt: at,
            },
            recipe: null,
            rawLine: entry.rawLine,
            amounts: [],
            createdAt: at,
            updatedAt: at,
          }),
        ),
        instructions: instructions.map((instruction) => ({ instruction })),
        createdAt: at,
        updatedAt: at,
      },
    ],
    images: [],
    meta: null,
    createdAt: at,
    updatedAt: at,
    dataQuality: testCompleteDataQuality(),
  });
}

export type RecipeFlowCase = {
  name: string;
  recipe: RecipeOut;
  expected: Omit<ExpectedRecipeFlow, "instructions" | "usages">;
};

export const recipeFlowCases: RecipeFlowCase[] = [
  {
    name: "recipe-flow-sequential-bread",
    recipe: recipeOf(
      "RCP-EVBRD",
      "Synthetic hearth loaf",
      [
        { usage: 0x101, name: "bread flour", rawLine: "500 g bread flour" },
        { usage: 0x102, name: "water", rawLine: "350 g water" },
        { usage: 0x103, name: "salt", rawLine: "10 g salt" },
        { usage: 0x104, name: "yeast", rawLine: "4 g instant yeast" },
      ],
      [
        "Heat the oven to 230C with a covered pot inside.",
        "Mix the flour, water, salt, and yeast into a shaggy dough.",
        "Knead for 10 minutes until smooth, then let rise for 1 hour.",
        "Shape the dough and bake in the covered pot for 35 minutes.",
      ],
    ),
    expected: {
      setupInstructions: [0],
      orderings: [
        [1, 2],
        [2, 3],
      ],
      dividedUsages: [],
    },
  },
  {
    name: "recipe-flow-divided-butter",
    recipe: recipeOf(
      "RCP-EVCRS",
      "Synthetic fruit crisp",
      [
        { usage: 0x201, name: "apples", rawLine: "6 apples, sliced" },
        { usage: 0x202, name: "butter", rawLine: "8 tbsp butter, divided" },
        { usage: 0x203, name: "oats", rawLine: "1 cup rolled oats" },
        { usage: 0x204, name: "brown sugar", rawLine: "1/2 cup brown sugar" },
      ],
      [
        "Heat the oven to 190C and butter a baking dish.",
        "Melt 2 tbsp of the butter and toss it with the apples in the dish.",
        "Rub the remaining 6 tbsp butter into the oats and brown sugar to make the topping.",
        "Scatter the topping over the apples and bake for 40 minutes until bubbling.",
      ],
    ),
    expected: {
      setupInstructions: [0],
      orderings: [
        [1, 3],
        [2, 3],
      ],
      dividedUsages: [uuid(0x202)],
    },
  },
  {
    name: "recipe-flow-parallel-pasta",
    recipe: recipeOf(
      "RCP-EVPST",
      "Synthetic tomato pasta",
      [
        { usage: 0x301, name: "spaghetti", rawLine: "400 g spaghetti" },
        { usage: 0x302, name: "olive oil", rawLine: "3 tbsp olive oil" },
        { usage: 0x303, name: "garlic", rawLine: "4 cloves garlic, sliced" },
        {
          usage: 0x304,
          name: "crushed tomatoes",
          rawLine: "1 can crushed tomatoes",
        },
      ],
      [
        "Bring a large pot of salted water to a boil and cook the spaghetti until al dente.",
        "Meanwhile, warm the olive oil and garlic over medium heat for 2 minutes, then add the tomatoes and simmer 15 minutes.",
        "Toss the drained spaghetti with the sauce.",
      ],
    ),
    expected: {
      setupInstructions: [],
      orderings: [
        [0, 2],
        [1, 2],
      ],
      dividedUsages: [],
    },
  },
  {
    // Pepper appears only in the prose: an unlisted source, never invented.
    name: "recipe-flow-unlisted-seasoning",
    recipe: recipeOf(
      "RCP-EVSUP",
      "Synthetic lentil soup",
      [
        { usage: 0x401, name: "onion", rawLine: "1 onion, diced" },
        { usage: 0x402, name: "lentils", rawLine: "1 cup red lentils" },
        { usage: 0x403, name: "stock", rawLine: "1 qt vegetable stock" },
      ],
      [
        "Soften the onion in a pot for 5 minutes.",
        "Add the lentils and stock and simmer for 20 minutes.",
        "Season with black pepper and blend until smooth.",
      ],
    ),
    expected: {
      setupInstructions: [],
      orderings: [
        [0, 1],
        [1, 2],
      ],
      dividedUsages: [],
    },
  },
  {
    name: "recipe-flow-marinate-and-grill",
    recipe: recipeOf(
      "RCP-EVGRL",
      "Synthetic yogurt chicken",
      [
        {
          usage: 0x501,
          name: "chicken thighs",
          rawLine: "1 kg chicken thighs",
        },
        { usage: 0x502, name: "yogurt", rawLine: "1 cup plain yogurt" },
        { usage: 0x503, name: "spice blend", rawLine: "2 tbsp spice blend" },
      ],
      [
        "Stir the yogurt and spice blend together.",
        "Coat the chicken in the yogurt mixture and marinate for 2 hours.",
        "Heat a grill to high.",
        "Grill the chicken 6 to 8 minutes per side until charred.",
      ],
    ),
    expected: {
      setupInstructions: [2],
      orderings: [
        [0, 1],
        [1, 3],
      ],
      dividedUsages: [],
    },
  },
];

/** The authored evidence `scoreRecipeFlow` grounds a plan's numbers in. */
export function recipeEvidence(recipe: RecipeOut) {
  const [section] = recipe.sections;
  return {
    instructions:
      section?.instructions.map(({ instruction }) => instruction) ?? [],
    usages:
      section?.ingredients.map((usage) => ({
        usageId: usage.id,
        rawLine: usage.rawLine ?? "",
      })) ?? [],
  };
}
