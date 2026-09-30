import { readFileSync } from "node:fs";
import { buildActorContext } from "@cubby/schemas/context";
import { userId } from "@cubby/schemas/identifiers";
import { z } from "zod";

const flags = process.argv.slice(2);
const target = flags.find((flag) => flag.startsWith("--target="))?.slice(9);
const policyFile = flags
  .find((flag) => flag.startsWith("--policy-file="))
  ?.slice(14);
const fingerprint = flags.find((flag) => flag.startsWith("--apply="))?.slice(8);
if (
  !["dev", "production"].includes(target ?? "") ||
  !policyFile ||
  flags.length !== (fingerprint ? 3 : 2)
) {
  throw new Error(
    "Usage: review-evidence-policies.ts --target=dev|production --policy-file=<reviewed JSON> [--apply=<reviewed fingerprint>]",
  );
}
const connection =
  target === "production"
    ? process.env.PRODUCTION_DIRECT_DATABASE_URL
    : process.env.EVIDENCE_POLICY_ROLLOUT_DEV_DATABASE_URL;
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
const {
  reviewedEvidencePolicyDecisions,
  previewReviewedEvidencePolicies,
  applyReviewedEvidencePolicies,
} = await import("../src/server/repo/reviewed-evidence-policies");
const decisions = reviewedEvidencePolicyDecisions.parse(
  JSON.parse(readFileSync(policyFile!, "utf8")),
);

await withRequestDbClient(connection, async () => {
  if (fingerprint) {
    const reviewed = z
      .string()
      .regex(/^[a-f\d]{64}$/u)
      .parse(fingerprint);
    const actor = userId.parse(
      process.env.EVIDENCE_POLICY_ROLLOUT_ACTOR_USER_ID,
    );
    const { buildCrudServices } = await import("../src/server/request-context");
    const result = await applyReviewedEvidencePolicies(
      {
        ...buildCrudServices(db),
        actorContext: buildActorContext(actor, "api"),
      },
      decisions,
      reviewed,
    );
    console.log(JSON.stringify({ target, applied: true, ...result }));
  } else {
    const plan = await withTransactionDatabase(
      db,
      (database) => previewReviewedEvidencePolicies(database, decisions),
      { accessMode: "read only", isolationLevel: "repeatable read" },
    );
    console.log(
      JSON.stringify({
        target,
        applied: false,
        fingerprint: plan.fingerprint,
        updatedEntities: plan.updates.length,
        preservedFields: plan.preservedFields,
        transitions: plan.transitions,
        blocked: plan.blocked,
        unreviewedChildren: plan.unreviewedChildren,
      }),
    );
  }
});
