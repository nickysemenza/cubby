import process from "node:process";

const flags = process.argv.slice(2);
const target = flags.find((flag) => flag.startsWith("--target="))?.slice(9);
if (flags.some((flag) => flag.startsWith("--apply="))) {
  throw new Error(
    "Statement category backfill is retired. Use spending-classification-seed.ts or the reviewed classification workflow.",
  );
}
if (!["dev", "production"].includes(target ?? "") || flags.length !== 1) {
  throw new Error(
    "Usage: import-spending-categories.ts --target=dev|production (read-only source evidence preview)",
  );
}
const connection =
  target === "production"
    ? process.env.PRODUCTION_DIRECT_DATABASE_URL
    : process.env.CATEGORY_ROLLOUT_DEV_DATABASE_URL;
if (!connection)
  throw new Error(
    "Provide the explicit target database URL; ambient DATABASE_URL is never used for this rollout.",
  );
const url = new URL(connection);
if (
  target === "production"
    ? !url.hostname.endsWith(".neon.tech") || url.hostname.includes("-pooler.")
    : !["127.0.0.1", "localhost"].includes(url.hostname)
) {
  throw new Error(
    "Expected a verified direct production endpoint, or a loopback development endpoint.",
  );
}
process.env.DATABASE_URL = connection;
delete process.env.E2E_DATABASE_URL;
const { db, withRequestDbClient } = await import("../src/server/db");
const { withTransactionDatabase } =
  await import("../src/server/repo/database-helpers");
const { previewImportedSpendingCategories } =
  await import("../src/server/repo/imported-spending-categories");

await withRequestDbClient(connection, async () => {
  const plan = await withTransactionDatabase(
    db,
    (database) => previewImportedSpendingCategories(database),
    { accessMode: "read only" },
  );
  console.log(
    JSON.stringify({
      target,
      applied: false,
      fingerprint: plan.fingerprint,
      existingCategories: plan.categories.filter(
        (category) => category.existingId !== null,
      ).length,
      newCategories: plan.categories.filter(
        (category) => category.existingId === null,
      ).length,
      transactions: plan.transactions.length,
      purchases: plan.purchases.length,
      unresolvedPurchases: plan.unresolvedPurchases,
    }),
  );
});
