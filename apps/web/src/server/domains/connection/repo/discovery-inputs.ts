/**
 * Complete classes of authoritative discovery inputs, including negative
 * scans. Search dependencies are a different contract. The source's own
 * revision is always included separately.
 */
const kinds = (...values: readonly string[]) =>
  values.map((kind) => `kind:${kind}`);
const context = (...values: readonly string[]) =>
  values.map((table) => `context:${table}`);
const evidence = [
  ...kinds("image"),
  ...context(
    "EntityLink",
    "EntityAttachment",
    "EntityExternalId",
    "EntitySource",
    "AiAnalysis",
    "AssessmentState",
  ),
];
const mail = context("OrderMail", "OrderMailEvent");

const inputs = new Map<string, readonly string[]>(
  Object.entries({
    product: [
      ...kinds(
        "product",
        "purchase",
        "expense",
        "ingredient",
        "plant",
        "productCategory",
      ),
      ...evidence,
      ...context("ImportSourceProduct", "ImportSourceOrder"),
    ],
    purchase: [
      ...kinds("product", "expense", "vendor", "vendorAccount"),
      ...evidence,
      ...mail,
      ...context("FinancialTransactionAllocation"),
    ],
    expense: [
      ...kinds(
        "product",
        "expense",
        "purchase",
        "project",
        "vendor",
        "productCategory",
        "spendingCategory",
      ),
      ...evidence,
      ...context("ExpenseAttribution", "FinancialTransactionAllocation"),
    ],
    task: [
      ...kinds("product", "project", "task", "productCategory"),
      ...evidence,
    ],
    cookbook: [...kinds("product"), ...evidence],
    device: [...kinds("product"), ...evidence],
    inventory: [...kinds("inventory", "product", "location"), ...evidence],
    project: [
      ...kinds("product", "inventory", "task", "expense", "project"),
      ...evidence,
    ],
    financialTransaction: [
      ...kinds("financialTransaction", "financialAccount", "purchase"),
      ...context("FinancialTransactionAllocation", "EntityExternalId"),
    ],
    email: [...mail, ...evidence, ...kinds("purchase", "vendorAccount")],
    ingredient: [...kinds("product", "recipe"), ...evidence],
    plant: [...kinds("product"), ...evidence],
    location: [],
  }),
);

export const connectionInputKeys = (kind: string): readonly string[] =>
  inputs.get(kind) ?? [];
export const connectionInputFamilies = () => [...inputs.keys()];
