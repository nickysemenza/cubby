import { suggestionStatus } from "@cubby/schemas/ai";
import { auditLogActionSchema } from "@cubby/schemas/audit";
import { auditAuthoritySchema, SYSTEM_USER_ID } from "@cubby/schemas/context";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { FieldGuess, FieldOrigin } from "@cubby/schemas/field-authority";
import { suggestApplyPolicy } from "@cubby/schemas/field-suggestion-policy";
import {
  feedbackAuthority,
  feedbackVerdict,
  suggestionFamily,
} from "@cubby/schemas/suggestion";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import { fieldInputFingerprintIfLive } from "~/server/generic/suggestions/repo/field-input-fence";

/**
 * Who holds a field. `open`: nothing decided it, so Cubby may fill it.
 * `cubby`: Cubby's Automatic rule wrote the current value (or a member handed
 * the field back) and nobody kept it, so Cubby may revise it. `person`: a
 * member, an import or an agent decided it, and Cubby never overwrites it.
 */
export type FieldAuthority =
  | { holder: "open" }
  | {
      holder: "cubby";
      suggestionId: string | null;
      confidence: number | null;
      at: Date;
    }
  | {
      holder: "person";
      at: Date | null;
      auditId: string | null;
      /** Set when a member kept a value Cubby set. */
      keptAt: Date | null;
    };

const row = z.object({
  live: z.unknown(),
  hasLive: z.boolean(),
  auditId: z.string().nullable(),
  authority: z.enum(["automatic", "released"]).nullable(),
  writtenAt: z.coerce.date().nullable(),
  matches: z.boolean().nullable(),
  suggestionId: z.string().nullable(),
  confidence: z.number().nullable(),
  keptAt: z.coerce.date().nullable(),
});

const empty = (value: unknown) => value == null || value === "";

/**
 * The newest update audit row naming the field decides. Anything ambiguous —
 * a timestamp tie, an out-of-band write, an audit row whose `to` differs from
 * the stored value — falls to `person`, the branch that never overwrites.
 */
export async function fieldAuthority(
  db: RepositoryQueryInput,
  entity: ShortcodeEntity,
  recordId: string,
  field: string,
): Promise<FieldAuthority> {
  const table = SHORTCODE_TABLE[entity];
  const result = await unwrapDb(db).execute<z.input<typeof row>>(sql`
    WITH stored AS (
      SELECT to_jsonb(t) ? ${field} AS "hasLive", to_jsonb(t)->${field} AS live
      FROM ${table} t WHERE t.id = ${recordId}::uuid
    ), latest AS (
      SELECT a.id, a.authority, a."createdAt", a.changes->${field}->'to' AS "to"
      FROM "AuditLog" a
      WHERE a."entityKind" = ${entity} AND a."entityId" = ${recordId}::uuid
        AND a.action = ${auditLogActionSchema.enum.update} AND a.changes ? ${field}
      ORDER BY a."createdAt" DESC, a.id DESC
      LIMIT 1
    )
    SELECT stored.live, COALESCE(stored."hasLive", false) AS "hasLive",
      latest.id::text AS "auditId", latest.authority,
      latest."createdAt" AS "writtenAt",
      latest."to" IS NOT DISTINCT FROM stored.live AS matches,
      receipt.id::text AS "suggestionId", receipt.confidence, receipt."keptAt"
    FROM (SELECT 1) one
    LEFT JOIN stored ON true
    LEFT JOIN latest ON true
    LEFT JOIN LATERAL (
      SELECT s.id,
        (s."acceptanceReceipt"->>'confidence')::double precision AS confidence,
        (SELECT max(member."createdAt"::timestamptz)
          FROM jsonb_to_recordset(s.decisions)
            member(authority text, verdict text, "createdAt" text)
          WHERE member.authority = ${feedbackAuthority.enum.member}
            AND member.verdict = ${feedbackVerdict.enum.correct}
            AND member."createdAt"::timestamptz
              >= (s."acceptanceReceipt"->>'acceptedAt')::timestamptz
        ) AS "keptAt"
      FROM "Suggestion" s
      WHERE latest.authority = ${auditAuthoritySchema.enum.automatic}
        AND s.family = ${suggestionFamily.enum.field} AND s.entity = ${entity}
        AND s."recordId" = ${recordId}::uuid AND s.field = ${field}
        AND s."acceptanceReceipt"->'auditIds' ? latest.id::text
      ORDER BY s."createdAt" DESC
      LIMIT 1
    ) receipt ON true
  `);
  const fact = row.parse(result.rows[0]);
  const live = fact.live;
  if (!fact.auditId)
    return empty(live) && fact.hasLive
      ? { holder: "open" }
      : { holder: "person", at: null, auditId: null, keptAt: null };
  if (fact.authority === "released") {
    if (empty(live)) return { holder: "open" };
    // A value written after the hand-back without its own audit row is a person's.
    if (fact.matches === true)
      return {
        holder: "cubby",
        suggestionId: null,
        confidence: null,
        at: fact.writtenAt ?? new Date(0),
      };
  }
  if (
    fact.authority === "automatic" &&
    fact.matches === true &&
    fact.suggestionId
  ) {
    if (fact.keptAt)
      return {
        holder: "person",
        at: fact.writtenAt,
        auditId: fact.auditId,
        keptAt: fact.keptAt,
      };
    return {
      holder: "cubby",
      suggestionId: fact.suggestionId,
      confidence: fact.confidence,
      at: fact.writtenAt ?? new Date(0),
    };
  }
  return {
    holder: "person",
    at: fact.writtenAt,
    auditId: fact.auditId,
    keptAt: null,
  };
}

const guessRow = z.object({
  suggestionId: z.string(),
  value: z.json(),
  confidence: z.number(),
  runnerUpValue: z.json().nullable(),
  runnerUpConfidence: z.number().nullable(),
  fence: z.string().nullable(),
});

const actorRow = z.object({
  userId: z.string(),
  channel: z.string(),
  name: z.string().nullable(),
});

/**
 * The active pending answer whose inputs still match the record: the picker's
 * guess. A read; it writes and schedules nothing.
 */
export async function readFieldGuess(
  db: RepositoryQueryInput,
  entity: ShortcodeEntity,
  recordId: string,
  field: string,
): Promise<FieldGuess | null> {
  const result = await unwrapDb(db).execute<z.input<typeof guessRow>>(sql`
    SELECT s.id::text AS "suggestionId", s."suggestedValue" AS value,
      s.confidence, s."runnerUpValue", s."runnerUpConfidence",
      s.data->>'liveInputFingerprint' AS fence
    FROM "Suggestion" s
    WHERE s.family = ${suggestionFamily.enum.field} AND s.entity = ${entity}
      AND s."recordId" = ${recordId}::uuid AND s.field = ${field}
      AND s.status = ${suggestionStatus.enum.pending} AND s.active
    ORDER BY s."createdAt" DESC, s.id DESC
    LIMIT 1
  `);
  const found = guessRow.safeParse(result.rows[0]).data;
  if (!found || found.value === null) return null;
  if (
    found.fence !==
    (await fieldInputFingerprintIfLive(db, entity, recordId, field))
  )
    return null;
  return {
    suggestionId: found.suggestionId,
    value: found.value,
    confidence: found.confidence,
    runnerUp:
      found.runnerUpValue !== null && found.runnerUpConfidence !== null
        ? { value: found.runnerUpValue, confidence: found.runnerUpConfidence }
        : null,
  };
}

/** Who holds the field, who wrote it, and Cubby's guess, for Why this value. */
export async function describeFieldOrigin(
  db: RepositoryQueryInput,
  entity: ShortcodeEntity,
  recordId: string,
  field: string,
): Promise<FieldOrigin> {
  const authority = await fieldAuthority(db, entity, recordId, field);
  const auditId = authority.holder === "person" ? authority.auditId : null;
  let writer: FieldOrigin["writer"] = null;
  // A kept value's newest audit row is still Cubby's write.
  if (
    authority.holder === "cubby" ||
    (authority.holder === "person" && authority.keptAt)
  )
    writer = { kind: "cubby", name: null };
  else if (auditId) {
    const actor = actorRow.safeParse(
      (
        await unwrapDb(db).execute<z.input<typeof actorRow>>(sql`
            SELECT a."userId", a.channel, u.name
            FROM "AuditLog" a LEFT JOIN "user" u ON u.id = a."userId"
            WHERE a.id = ${auditId}::uuid
          `)
      ).rows[0],
    ).data;
    if (actor)
      writer =
        actor.userId === SYSTEM_USER_ID
          ? { kind: "import", name: null }
          : actor.channel === "mcp"
            ? { kind: "agent", name: null }
            : { kind: "member", name: actor.name };
  }
  const at = authority.holder === "open" ? null : authority.at;
  return {
    holder: authority.holder,
    at: at ? at.toISOString() : null,
    confidence: authority.holder === "cubby" ? authority.confidence : null,
    keptAt:
      authority.holder === "person" && authority.keptAt
        ? authority.keptAt.toISOString()
        : null,
    writer,
    released: authority.holder === "cubby" && authority.suggestionId === null,
    apply: suggestApplyPolicy(entity, field),
    fillOnly: Boolean(
      entityFieldByKey(entity, field)?.control?.suggest?.fillOnly,
    ),
    guess:
      authority.holder === "person"
        ? null
        : await readFieldGuess(db, entity, recordId, field),
  };
}
