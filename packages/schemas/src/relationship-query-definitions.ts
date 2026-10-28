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

const definition = <
  const Key extends string,
  const Source extends string,
  const Target extends string,
  const Kind extends string,
>(
  key: Key,
  source: Source,
  target: Target,
  kind: Kind,
  history = false,
) => ({ key, source, target, kind, history });

const relationshipQueryDefinitions = [
  ...localRelationshipEntities.map((target) =>
    definition(`jobSubject${target}`, "job", target, "jobSubject"),
  ),
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

/** Endpoints derive from the executable query roster, including the Job subject family. */
type QueryDefinition = (typeof relationshipQueryDefinitions)[number];
export type RelationshipQueryKey = QueryDefinition["key"];
type JobSubject = (typeof localRelationshipEntities)[number];
export type RelationshipQuerySource<K extends RelationshipQueryKey> =
  K extends `jobSubject${JobSubject}`
    ? "job"
    : Extract<QueryDefinition, { key: K }>["source"];
export type RelationshipQueryTarget<K extends RelationshipQueryKey> =
  K extends `jobSubject${infer Target extends JobSubject}`
    ? Target
    : Extract<QueryDefinition, { key: K }>["target"];

export const relationshipQueryDefinition = (key: string) => {
  const found = relationshipQueryDefinitions.find((item) => item.key === key);
  if (!found) throw new Error(`Unknown relationship query ${key}`);
  return found;
};
