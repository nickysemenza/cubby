import { buildActorContext } from "@cubby/schemas/context";
import { userId } from "@cubby/schemas/identifiers";
import { z } from "zod";

const flags = process.argv.slice(2);
const target = flags.find((flag) => flag.startsWith("--target="))?.slice(9);
const fingerprint = flags.find((flag) => flag.startsWith("--apply="))?.slice(8);
if (
  !["dev", "production"].includes(target ?? "") ||
  flags.length !== (fingerprint ? 2 : 1)
) {
  throw new Error(
    "Usage: import-spending-categories.ts --target=dev|production [--apply=<reviewed fingerprint>]",
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
const { previewImportedSpendingCategories, applyImportedSpendingCategories } =
  await import("../src/server/repo/imported-spending-categories");

await withRequestDbClient(connection, async () => {
  if (fingerprint) {
    const reviewed = z
      .string()
      .regex(/^[a-f\d]{64}$/u)
      .parse(fingerprint);
    const actor = userId.parse(process.env.CATEGORY_ROLLOUT_ACTOR_USER_ID);
    const { buildCrudServices } = await import("../src/server/request-context");
    const result = await applyImportedSpendingCategories(
      {
        ...buildCrudServices(db),
        actorContext: buildActorContext(actor, "api"),
      },
      reviewed,
    );
    console.log(JSON.stringify({ target, applied: true, ...result }));
  } else {
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
  }
});
