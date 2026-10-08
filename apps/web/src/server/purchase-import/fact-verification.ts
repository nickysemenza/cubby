import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  fieldExplanationVerification,
  type FieldExplanationVerification,
} from "@cubby/schemas/field-explanation";
import type { LedgerPartyId, RunId } from "@cubby/schemas/identifiers";
import {
  acceptedResearchFact,
  type AcceptedResearchFact,
} from "@cubby/schemas/research";
import { runTargetEntityKind } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  run as runTable,
  runEvidence,
  runFactEvidence,
  runTarget,
} from "~/server/db/schema";
import { notDeleted, withTransactionOn } from "~/server/repo/database-helpers";
import { SHORTCODE_TABLE } from "~/server/repo/shortcode-tables";

type JsonValue = AcceptedResearchFact["value"];
type TargetEntityKind = typeof runTarget.$inferSelect.entityKind;
type FactSubject = Pick<
  typeof runTarget.$inferSelect,
  "entityKind" | "entityId"
>;

/** Reads declared relation/virtual fields from canonical repositories using this transaction. */
export type ResearchCanonicalProjection = (
  tx: DrizzleTransaction,
  target: {
    entityKind: TargetEntityKind;
    entityId: string;
    fieldPaths: readonly string[];
  },
) => Promise<Record<string, JsonValue> | null>;

export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = z.record(z.string(), z.json()).safeParse(value);
  if (!object.success) return JSON.stringify(value);
  return `{${Object.keys(object.data)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object.data[key]!)}`)
    .join(",")}}`;
}

// JSON null is a retained value; Drizzle maps a JS null parameter to SQL NULL.
const jsonValueParameter = (value: JsonValue): JsonValue | SQL =>
  value === null ? sql`'null'::jsonb` : value;

function pathValue(
  value: JsonValue,
  path: readonly string[],
): JsonValue | undefined {
  if (path.length === 0) return value;
  const [key, ...rest] = path;
  const object = z.record(z.string(), z.json()).safeParse(value);
  if (!key || !object.success || !Object.hasOwn(object.data, key))
    return undefined;
  return pathValue(object.data[key]!, rest);
}

async function lockCanonicalFactValues(
  tx: DrizzleTransaction,
  subject: FactSubject,
  claims: readonly AcceptedResearchFact[],
  readCanonicalProjection?: ResearchCanonicalProjection,
): Promise<Map<string, JsonValue>> {
  const entityKind = runTargetEntityKind.parse(subject.entityKind);
  const entityId = z.uuid().parse(subject.entityId);
  const table = SHORTCODE_TABLE[entityKind];
  const model = entityFieldModels[entityKind];
  const columns = getTableColumns(table);
  const [live] = await tx
    .select()
    .from(table)
    .where(and(eq(table.id, entityId), notDeleted(table)))
    .limit(1)
    .for("update");
  if (!live) throw new Error("Research target has no live entity");

  const fieldPaths = [...new Set(claims.map((claim) => claim.fieldPath))];
  for (const fieldPath of fieldPaths) {
    const root = fieldPath.split(".")[0];
    if (
      !model.fields.some(
        (field) => field.key === root || field.readKey === root,
      ) &&
      !model.storage.some((field) => field.key === root) &&
      !model.output.some((key) => key === root)
    ) {
      throw new Error(
        `Research field ${fieldPath} is not declared for ${entityKind}`,
      );
    }
  }

  const externalPaths = fieldPaths.filter(
    (path) => !Object.hasOwn(columns, path.split(".")[0]!),
  );
  const projected: Record<string, JsonValue> | null =
    externalPaths.length > 0 && readCanonicalProjection
      ? await readCanonicalProjection(tx, {
          entityKind,
          entityId,
          fieldPaths: externalPaths,
        })
      : {};
  if (projected === null)
    throw new Error("Research target has no live entity projection");
  const canonicalValues = new Map<string, JsonValue>();
  const liveColumns = z.record(z.string(), z.unknown()).parse(live);
  for (const fieldPath of fieldPaths) {
    const path = fieldPath.split(".");
    const stored = Object.hasOwn(columns, path[0]!);
    const storedValue = stored
      ? z.json().safeParse(liveColumns[path[0]!])
      : null;
    const current = storedValue?.success
      ? pathValue(storedValue.data, path.slice(1))
      : projected[fieldPath];
    const parsed = z.json().safeParse(current);
    if (!parsed.success)
      throw new Error(`Research field ${fieldPath} has no canonical value`);
    canonicalValues.set(fieldPath, parsed.data);
  }
  return canonicalValues;
}

function canonicalFactSubject(
  target: FactSubject,
  requested?: FactSubject,
): FactSubject {
  if (
    requested &&
    target.entityKind === "run" &&
    requested.entityKind !== "purchase"
  )
    throw new Error("Source research can prove only its host-bound Purchase.");
  if (
    requested &&
    target.entityKind !== "run" &&
    (requested.entityKind !== target.entityKind ||
      requested.entityId !== target.entityId)
  )
    throw new Error("Research fact subject differs from its entity task.");
  return requested ?? target;
}

/**
 * Accepted facts prove canonical values without mutating them. The caller owns
 * the transaction and semantic acceptance; this boundary fences task ownership,
 * evidence ownership and current values before retaining any observation.
 */
export async function recordAcceptedFactEvidence(
  tx: DrizzleTransaction,
  input: {
    runId: RunId;
    targetId: string;
    /** Host-bound canonical subject, independent of the originating source task. */
    subject?: FactSubject;
    claims: readonly AcceptedResearchFact[];
  },
  readCanonicalProjection?: ResearchCanonicalProjection,
): Promise<{ inserted: number }> {
  const claims = input.claims.map((claim) => acceptedResearchFact.parse(claim));
  const [target] = await tx
    .select()
    .from(runTarget)
    .where(
      and(eq(runTarget.id, input.targetId), eq(runTarget.runId, input.runId)),
    )
    .limit(1)
    .for("update");
  if (!target) throw new Error("Research target does not belong to this run");
  const subject = canonicalFactSubject(target, input.subject);
  const canonicalValues = await lockCanonicalFactValues(
    tx,
    subject,
    claims,
    readCanonicalProjection,
  );

  if (claims.length === 0) return { inserted: 0 };
  const evidenceIds = [...new Set(claims.map((claim) => claim.evidenceId))];
  const evidence = await tx
    .select({ id: runEvidence.id })
    .from(runEvidence)
    .where(
      and(
        inArray(runEvidence.id, evidenceIds),
        eq(runEvidence.runId, input.runId),
        eq(runEvidence.targetId, input.targetId),
      ),
    )
    .for("share");
  if (evidence.length !== evidenceIds.length) {
    throw new Error(
      "Research evidence does not belong to this exact run and target",
    );
  }

  const rows: Array<
    Omit<typeof runFactEvidence.$inferInsert, "value"> & {
      value: JsonValue | SQL;
    }
  > = [];
  for (const claim of claims) {
    const value = canonicalJson(claim.value);
    const current = canonicalValues.get(claim.fieldPath);
    if (current === undefined || canonicalJson(current) !== value) {
      throw new Error(
        `Research field ${claim.fieldPath} does not match its canonical value`,
      );
    }
    rows.push({
      targetId: input.targetId,
      evidenceId: claim.evidenceId,
      entityKind: subject.entityKind,
      entityId: subject.entityId,
      fieldPath: claim.fieldPath,
      value: jsonValueParameter(claim.value),
      valueFingerprint: await sha256Hex(value),
      support: claim.support,
    });
  }
  const inserted = await tx
    .insert(runFactEvidence)
    .values(rows)
    .onConflictDoNothing({
      target: [
        runFactEvidence.targetId,
        runFactEvidence.evidenceId,
        runFactEvidence.entityKind,
        runFactEvidence.entityId,
        runFactEvidence.fieldPath,
        runFactEvidence.valueFingerprint,
      ],
    })
    .returning({ id: runFactEvidence.id });
  return { inserted: inserted.length };
}

/** Current-value proof only; relation facts stay hidden until a canonical projection is supplied. */
export async function loadCurrentFactEvidence(
  db: Database | DrizzleTransaction,
  input: {
    entityKind: Entity;
    entityId: string;
    fieldPath: string;
    ledgerPartyId?: LedgerPartyId;
  },
  readCanonicalProjection?: ResearchCanonicalProjection,
): Promise<FieldExplanationVerification[]> {
  const entityKind = input.entityKind;
  if (entityKind === "usda-food") return [];
  const subjectKind = runTargetEntityKind.safeParse(entityKind);
  if (!subjectKind.success) return [];
  return withTransactionOn(db, async (tx) => {
    const table = SHORTCODE_TABLE[entityKind];
    const [live] = await tx
      .select()
      .from(table)
      .where(and(eq(table.shortcode, input.entityId), notDeleted(table)))
      .limit(1);
    if (!live) return [];
    const path = input.fieldPath.split(".");
    const columns = getTableColumns(table);
    const stored = Object.hasOwn(columns, path[0]!);
    const liveColumns = z.record(z.string(), z.unknown()).parse(live);
    const storedValue = stored
      ? z.json().safeParse(liveColumns[path[0]!])
      : null;
    const projected =
      !stored && readCanonicalProjection
        ? await readCanonicalProjection(tx, {
            entityKind: subjectKind.data,
            entityId: live.id,
            fieldPaths: [input.fieldPath],
          })
        : null;
    const values: Record<string, JsonValue> = {};
    const current = storedValue?.success
      ? pathValue(storedValue.data, path.slice(1))
      : undefined;
    const parsed = z.json().safeParse(current);
    if (parsed.success) values[input.fieldPath] = parsed.data;
    if (!stored && projected) {
      for (const [fieldPath, value] of Object.entries(projected)) {
        if (
          fieldPath === input.fieldPath ||
          fieldPath.startsWith(`${input.fieldPath}.`)
        )
          values[fieldPath] = value;
      }
    }
    const fingerprints = await Promise.all(
      Object.entries(values).map(async ([fieldPath, value]) => ({
        fieldPath,
        value,
        canonical: canonicalJson(value),
        fingerprint: await sha256Hex(canonicalJson(value)),
      })),
    );
    if (fingerprints.length === 0) return [];
    const currentByPath = new Map(
      fingerprints.map((value) => [value.fieldPath, value]),
    );
    const rows = await tx
      .select({
        factId: runFactEvidence.id,
        fieldPath: runFactEvidence.fieldPath,
        value: runFactEvidence.value,
        valueFingerprint: runFactEvidence.valueFingerprint,
        support: runFactEvidence.support,
        supportRetiredAt: runFactEvidence.supportRetiredAt,
        createdAt: runFactEvidence.createdAt,
        runShortcode: runTable.shortcode,
        kind: runEvidence.kind,
        sourceMetadata: runEvidence.sourceMetadata,
      })
      .from(runFactEvidence)
      .innerJoin(runTarget, eq(runTarget.id, runFactEvidence.targetId))
      .innerJoin(
        runTable,
        and(eq(runTable.id, runTarget.runId), notDeleted(runTable)),
      )
      .innerJoin(
        runEvidence,
        and(
          eq(runEvidence.id, runFactEvidence.evidenceId),
          eq(runEvidence.runId, runTarget.runId),
          eq(runEvidence.targetId, runTarget.id),
        ),
      )
      .where(
        and(
          eq(runFactEvidence.entityId, live.id),
          eq(runFactEvidence.entityKind, subjectKind.data),
          or(
            ...fingerprints.map((value) =>
              and(
                eq(runFactEvidence.fieldPath, value.fieldPath),
                eq(runFactEvidence.valueFingerprint, value.fingerprint),
              ),
            ),
          ),
          input.ledgerPartyId
            ? eq(runTable.ledgerPartyId, input.ledgerPartyId)
            : undefined,
        ),
      )
      .orderBy(desc(runFactEvidence.createdAt))
      .limit(50);
    return Promise.all(
      rows
        .filter(
          (row) =>
            canonicalJson(row.value) ===
            currentByPath.get(row.fieldPath)?.canonical,
        )
        .slice(0, 50)
        .map(async (row) => {
          const metadata = z
            .object({
              title: z.string().optional(),
              url: z.string().optional(),
              canonicalUrl: z.string().optional(),
              sourceURL: z.string().nullish(),
            })
            .parse(row.sourceMetadata);
          const url = z
            .url()
            .safeParse(
              metadata.canonicalUrl ?? metadata.url ?? metadata.sourceURL,
            );
          return fieldExplanationVerification.parse({
            key: await sha256Hex(row.factId),
            run: { entityKind: "run", entityId: row.runShortcode },
            subject: { entityKind: input.entityKind, entityId: input.entityId },
            fieldPath: row.fieldPath,
            value: currentByPath.get(row.fieldPath)!.value,
            verifiedAt: row.createdAt.toISOString(),
            support: row.support,
            supportRetiredAt: row.supportRetiredAt?.toISOString() ?? null,
            source: {
              label: metadata.title ?? "Retained source",
              url: url.success ? url.data : null,
              kind: row.kind,
            },
          });
        }),
    );
  });
}
