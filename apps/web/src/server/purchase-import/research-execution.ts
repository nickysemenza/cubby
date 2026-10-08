import { runEntityId } from "@cubby/schemas/identifiers";
import { researchCoordinatorStatus as coordinatorStatusSchema } from "@cubby/schemas/purchase-agent-services";
import {
  mailResearchRunInput,
  productResearchRunInput,
  purchaseValidationResearchRunInput,
  researchObjectivesRunInput,
} from "@cubby/schemas/run-fields";
import { and, eq, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { ledgerParty, run, runTarget } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { readCanonicalEntityIds } from "~/server/repo/entity-identity";

import { researchObjectiveKey } from "./research-objective";

const actorMember = alias(ledgerParty, "research_coordinator_actor");

/** Research owns its member's sources; photo inventory can name a shared owner. */
async function coordinatorRun(db: Database, runId: string) {
  const [owned] = await getDb(db)
    .select({ scope: run })
    .from(run)
    .innerJoin(
      ledgerParty,
      and(eq(ledgerParty.id, run.ledgerPartyId), notDeleted(ledgerParty)),
    )
    .innerJoin(
      actorMember,
      and(
        eq(actorMember.userId, run.actorUserId),
        eq(actorMember.kind, "member"),
        notDeleted(actorMember),
      ),
    )
    .where(
      and(
        eq(run.id, runEntityId.parse(runId)),
        notDeleted(run),
        or(
          eq(run.purpose, "photo_inventory"),
          eq(ledgerParty.id, actorMember.id),
        ),
      ),
    );
  if (!owned)
    throw new Error("Research coordinator member ownership is unavailable.");
  return owned.scope;
}

async function admittedTaskKeys(db: Database, scope: typeof run.$inferSelect) {
  if (scope.purpose === "mail_import") {
    const input = mailResearchRunInput.safeParse(scope.input);
    return input.success
      ? input.data.sources.map(
          (source) => `run:${scope.id}:${source.orderMailId}`,
        )
      : null;
  }
  if (scope.purpose === "product_enrichment") {
    const input = productResearchRunInput.safeParse(scope.input);
    if (!input.success) return null;
    const current = await readCanonicalEntityIds(
      db,
      "product",
      input.data.products.map((product) => product.productId),
    );
    return input.data.products.map(
      (product) =>
        `product:${current.get(product.productId) ?? ""}:${product.productId}`,
    );
  }
  if (scope.purpose === "purchase_validation") {
    const input = purchaseValidationResearchRunInput.safeParse(scope.input);
    if (!input.success) return null;
    const current = await readCanonicalEntityIds(
      db,
      "purchase",
      input.data.purchases.map((purchase) => purchase.purchaseId),
    );
    return input.data.purchases.map(
      (purchase) =>
        `purchase:${current.get(purchase.purchaseId) ?? ""}:${purchase.purchaseId}`,
    );
  }
  if (scope.purpose === "account_sync") {
    const input = researchObjectivesRunInput.safeParse(scope.input);
    return input.success
      ? input.data.objectives.map(
          (objective) => `run:${scope.id}:${researchObjectiveKey(objective)}`,
        )
      : null;
  }
  return null;
}

/** Historical JSON stays readable; only admitted replacement work can hydrate pi. */
export async function researchCoordinatorStatus(
  db: Database,
  runId: string,
): Promise<z.output<typeof coordinatorStatusSchema>> {
  const scope = await coordinatorRun(db, runId);
  if (scope.retiredAt) return "retired";
  return researchTaskAdmissionStatus(db, scope);
}

async function researchTaskAdmissionStatus(
  db: Database,
  scope: typeof run.$inferSelect,
): Promise<z.output<typeof coordinatorStatusSchema>> {
  // Photo inventory retains its separate execution contract.
  if (scope.purpose === "photo_inventory") return "ready";
  const expected = await admittedTaskKeys(db, scope);
  if (!expected) return "legacy";
  const targets = await getDb(db)
    .select({
      entityKind: runTarget.entityKind,
      entityId: runTarget.entityId,
      workKey: runTarget.workKey,
    })
    .from(runTarget)
    .where(eq(runTarget.runId, scope.id));
  const actual = new Set(
    targets.map(
      (target) =>
        `${target.entityKind}:${target.entityId}:${target.workKey ?? ""}`,
    ),
  );
  if (
    new Set(expected).size !== expected.length ||
    targets.length !== expected.length ||
    expected.some((key) => !actual.has(key))
  )
    return "incomplete_admission";
  return "ready";
}

/** Check before replay; execution may finish itself without invalidating its contract. */
export async function assertResearchRunExecutable(db: Database, runId: string) {
  const status = await researchCoordinatorStatus(db, runId);
  if (status === "retired")
    throw new Error(
      "Research coordinator permanently retired: unrelated_source.",
    );
  assertResearchTaskStatus(status);
}

/** Retired work may be carried only from a complete roster; this grants no execution authority. */
export async function assertResearchTaskAdmission(db: Database, runId: string) {
  const scope = await coordinatorRun(db, runId);
  assertResearchTaskStatus(await researchTaskAdmissionStatus(db, scope));
}

function assertResearchTaskStatus(
  status: z.output<typeof coordinatorStatusSchema>,
) {
  if (status === "legacy")
    throw new Error(
      "Legacy coordinator requires a fresh, admitted new research Run.",
    );
  if (status === "incomplete_admission")
    throw new Error(
      "Research task admission is incomplete or differs from its frozen inputs.",
    );
}
