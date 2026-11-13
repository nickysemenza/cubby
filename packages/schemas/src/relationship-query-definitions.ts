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
  "sourceOccurrence",
  "transactionImport",
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
    "sourceObservationAccount",
    "sourceTransactionRecord",
    "financialAccount",
    "sourceObservationAccount",
  ),
  definition(
    "sourceObservationWithdrawal",
    "sourceTransactionRecord",
    "transactionImport",
    "sourceObservationWithdrawal",
  ),
  definition(
    "sourceObservationSuccessor",
    "sourceTransactionRecord",
    "sourceTransactionRecord",
    "sourceObservationSuccessor",
  ),
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

/** Endpoints derive from the executable query roster. */
type QueryDefinition = (typeof relationshipQueryDefinitions)[number];
export type RelationshipQueryKey = QueryDefinition["key"];
export type RelationshipQuerySource<K extends RelationshipQueryKey> = Extract<
  QueryDefinition,
  { key: K }
>["source"];
export type RelationshipQueryTarget<K extends RelationshipQueryKey> = Extract<
  QueryDefinition,
  { key: K }
>["target"];

export const relationshipQueryDefinition = (key: string) => {
  const found = relationshipQueryDefinitions.find((item) => item.key === key);
  if (!found) throw new Error(`Unknown relationship query ${key}`);
  return found;
};
