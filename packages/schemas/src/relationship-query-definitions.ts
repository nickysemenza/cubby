/** Read-only associations whose evidence is not one foreign-key path. */
export const localRelationshipEntities = [
  "product",
  "recipe",
  "ingredient",
  "cookbook",
  "location",
  "inventory",
  "meal",
  "ledgerParty",
  "ledgerTransfer",
  "project",
  "task",
  "vendor",
  "purchase",
  "financialAccount",
  "financialTransaction",
  "wish",
  "expense",
  "image",
  "planting",
  "gardenEntry",
  "vendorAccount",
  "productCategory",
  "run",
  "device",
  "plant",
  "spendingCategory",
  "email",
  "imageJob",
  "sourceTransactionRecord",
  "transactionImport",
  "job",
  "shipment",
] as const;

const definition = <const Kind extends string>(
  key: string,
  source: string,
  target: string,
  kind: Kind,
  history = false,
) => ({ key, source, target, kind, history });

const relationshipQueryDefinitions = [
  ...localRelationshipEntities.flatMap((target) => [
    definition(`jobSubject${target}`, "job", target, "jobSubject"),
    definition(
      `evaluationTarget${target}`,
      "job",
      target,
      "evaluationTarget",
      true,
    ),
  ]),
  definition("evaluationRuns", "job", "run", "evaluationRuns", true),
  definition("imageExecution", "job", "imageJob", "imageExecution"),
  definition("imageLeaseDevice", "imageJob", "device", "imageLeaseDevice"),
  definition("purchaseEmails", "purchase", "email", "purchaseEmails"),
  definition("vendorEmails", "vendor", "email", "vendorEmails"),
  definition(
    "vendorAccountEmails",
    "vendorAccount",
    "email",
    "vendorAccountEmails",
  ),
  definition("memberPurchases", "ledgerParty", "purchase", "memberPurchases"),
  definition(
    "transactionSourceRecords",
    "financialTransaction",
    "sourceTransactionRecord",
    "transactionSourceRecords",
  ),
  definition(
    "reviewedEmailTransactions",
    "email",
    "financialTransaction",
    "reviewedEmailTransactions",
    true,
  ),
  definition(
    "reviewedEmailAccounts",
    "email",
    "financialAccount",
    "reviewedEmailAccounts",
    true,
  ),
];

export const relationshipQueryDefinition = (key: string) => {
  const found = relationshipQueryDefinitions.find((item) => item.key === key);
  if (!found) throw new Error(`Unknown relationship query ${key}`);
  return found;
};

/** Query inverses use the same evidence, with only the endpoints reversed. */
export const queryRelationship = (input: {
  key: string;
  label: string;
  query: string;
  target: string;
  cardinality?: "one" | "many";
}) => ({
  key: input.key,
  label: input.label,
  target: input.target,
  cardinality: input.cardinality ?? "many",
  provenance: { kind: "query" as const, query: input.query },
  inverse: {
    steps: [
      { edge: `Relationship.${input.query}`, direction: "incoming" as const },
    ],
  },
});
