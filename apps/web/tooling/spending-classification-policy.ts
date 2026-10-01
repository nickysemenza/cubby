import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { buildActorContext } from "@cubby/schemas/context";
import { spendingClassificationReviewInput } from "@cubby/schemas/spending-classification-review";
import { z } from "zod";

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    input: { type: "string" },
    apply: { type: "string" },
  },
});
const target = z.enum(["dev", "production"]).parse(values.target);
const connection =
  target === "production"
    ? process.env.PRODUCTION_DIRECT_DATABASE_URL
    : process.env.SPENDING_CLASSIFICATION_SEED_DEV_DATABASE_URL;
if (!connection)
  throw new Error("Provide an explicit classification target database URL.");
const url = new URL(connection);
if (
  target === "production"
    ? !url.hostname.endsWith(".neon.tech") || url.hostname.includes("-pooler")
    : !["localhost", "127.0.0.1"].includes(url.hostname)
)
  throw new Error(
    "Expected a verified direct production endpoint or a loopback development endpoint.",
  );
const input = spendingClassificationReviewInput.parse(
  JSON.parse(readFileSync(z.string().min(1).parse(values.input), "utf8")),
);
process.env.DATABASE_URL = connection;
delete process.env.E2E_DATABASE_URL;
const { db, withRequestDbClient } = await import("../src/server/db");
const { buildCrudServices } = await import("../src/server/request-context");
const {
  previewSpendingClassificationReview,
  applySpendingClassificationReview,
} = await import("../src/server/repo/spending-classification-review");
const { resolveSpendingClassificationSeedActor } =
  await import("../src/server/repo/spending-classification-seed");
await withRequestDbClient(connection, async () => {
  if (values.apply) {
    const fingerprint = z
      .string()
      .regex(/^[a-f\d]{64}$/u)
      .parse(values.apply);
    const actor = await resolveSpendingClassificationSeedActor(
      db,
      z
        .string()
        .min(1)
        .parse(process.env.SPENDING_CLASSIFICATION_SEED_ACTOR_NAME),
    );
    const result = await applySpendingClassificationReview(
      {
        ...buildCrudServices(db),
        actorContext: buildActorContext(actor, "api"),
      },
      { request: input, fingerprint },
    );
    console.log(
      JSON.stringify({
        target,
        applied: result.applied,
        updatedRecords: result.updatedRecords,
      }),
    );
  } else {
    const preview = await previewSpendingClassificationReview(db, input);
    const netDelta = preview.categoryDeltas.reduce(
      (sum, row) => sum + BigInt(row.afterCents) - BigInt(row.beforeCents),
      0n,
    );
    console.log(
      JSON.stringify({
        target,
        applied: false,
        fingerprint: preview.fingerprint,
        changedExpenseCount: preview.changedExpenseCount,
        beforeUncategorizedExpenseCount:
          preview.beforeUncategorizedExpenseCount,
        afterUncategorizedExpenseCount: preview.afterUncategorizedExpenseCount,
        unpricedExpenseCount: preview.unpricedExpenseCount,
        ledgerDeltaCents: netDelta.toString(),
      }),
    );
  }
});
