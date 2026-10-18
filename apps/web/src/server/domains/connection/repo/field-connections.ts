import type { AiProvenance } from "@cubby/schemas/ai-evaluation";
import type { EntityRef } from "@cubby/schemas/entity";
import {
  connectionAssessmentEvidence,
  type ConnectionCandidate,
  type ConnectionRelation,
} from "@cubby/schemas/entity-connections";
import type { RunId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { assessmentState } from "~/server/db/schema";
import { saveSweepSuggestions } from "~/server/domains/run/repo/suggestion-sweep-state";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";

import {
  captureConnectionBasis,
  connectionRecord,
} from "./connection-evidence";

const targets = new Map<
  string,
  { relation: ConnectionRelation; entityKind: EntityRef["entityKind"] }
>(
  Object.entries({
    "task.subjectProductId": {
      relation: "task-subject-product",
      entityKind: "product",
    },
    "product.ingredientId": {
      relation: "product-ingredient",
      entityKind: "ingredient",
    },
    "product.growsPlantId": {
      relation: "product-grows-plant",
      entityKind: "plant",
    },
    "cookbook.productId": {
      relation: "cookbook-product",
      entityKind: "product",
    },
    "device.productId": { relation: "device-product", entityKind: "product" },
  } satisfies Record<
    string,
    { relation: ConnectionRelation; entityKind: EntityRef["entityKind"] }
  >),
);

export async function prepareConnectionFieldGuard(
  db: Database,
  source: EntityRef,
) {
  return (await connectionRecord(db, source)).row;
}

export async function saveConnectionFieldGuard(
  db: Database,
  input: {
    source: EntityRef;
    field: string;
    decision: unknown;
    before: unknown;
    inputs: unknown;
    dependencies: AiProvenance["dependencies"];
    model: string;
    reviewKey: string;
  },
) {
  const target = targets.get(`${input.source.entityKind}.${input.field}`);
  if (!target) throw new Error("Unsupported connection field");
  const candidate: ConnectionCandidate = {
    relation: target.relation,
    source: input.source,
    target: {
      entityKind: target.entityKind,
      entityId: z.string().parse(input.decision),
    },
    label: "Review declared field connection",
    evidence: {
      reasons: ["Declared field inference"],
      contradictions: [],
      unknowns: ["Member review required"],
    },
  };
  const basis = await captureConnectionBasis(db, candidate);
  const parsedBasis = z.object({ source: z.json() }).parse(basis);
  if (
    canonicalJson(parsedBasis.source) !==
    canonicalJson(z.json().parse(input.before))
  )
    throw new Error("Connection source changed during inference");
  const evidence = connectionAssessmentEvidence.parse({
    version: 1,
    candidate,
    basis,
  });
  const fingerprint = await sha256Hex(canonicalJson(evidence));
  const reviewKey = input.reviewKey;
  return {
    reviewKey,
    provenance: {
      inputFingerprint: fingerprint,
      optionFingerprint: await sha256Hex(
        canonicalJson(z.json().parse(input.inputs)),
      ),
      model: input.model,
      dependencies: input.dependencies,
    } satisfies AiProvenance,
    async publish(
      runId: RunId,
      publication: Parameters<typeof saveSweepSuggestions>[2],
      entries: Parameters<typeof saveSweepSuggestions>[3],
      context: EntityKernelContext,
    ) {
      return withTransactionDatabase(context.db, async (db) => {
        const current = await captureConnectionBasis(db, candidate, true);
        if (canonicalJson(current) !== canonicalJson(basis))
          throw new Error("Connection evidence changed during inference");
        await saveSweepSuggestions(db, runId, publication, entries, null, {
          ...context,
          db,
        });
        await getDb(db)
          .update(assessmentState)
          .set({ data: { reviewKey, connectionEvidence: evidence } })
          .where(
            and(
              eq(assessmentState.runId, runId),
              eq(assessmentState.recordId, publication.recordId),
              eq(assessmentState.field, input.field),
              eq(assessmentState.status, "pending"),
              sql`${assessmentState.data}->>'reviewKey'=${reviewKey}`,
            ),
          );
      });
    },
  };
}

/** Root calls this before a field application; ordinary field Assessments are untouched. */
export async function assertConnectionFieldFresh(
  db: Database,
  assessmentId: string,
) {
  const [state] = await getDb(db)
    .select()
    .from(assessmentState)
    .where(eq(assessmentState.id, assessmentId))
    .limit(1);
  if (!state) throw new Error("Field Assessment not found");
  const data = z
    .object({ connectionEvidence: connectionAssessmentEvidence })
    .safeParse(state.data);
  if (!data.success) return;
  const current = await captureConnectionBasis(
    db,
    data.data.connectionEvidence.candidate,
    true,
  );
  if (
    canonicalJson(current) !== canonicalJson(data.data.connectionEvidence.basis)
  )
    throw new Error("Connection field evidence changed before acceptance");
  const [fresh] = await getDb(db)
    .select()
    .from(assessmentState)
    .where(eq(assessmentState.id, assessmentId))
    .limit(1)
    .for("update");
  if (!fresh?.active || fresh.status !== "pending")
    throw new Error("Connection field Assessment is no longer pending");
}
