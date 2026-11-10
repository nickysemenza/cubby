import { auditLogActionSchema } from "@cubby/schemas/audit";
import { auditAuthoritySchema } from "@cubby/schemas/context";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  feedbackAuthority,
  feedbackVerdict,
  suggestionFamily,
} from "@cubby/schemas/suggestion";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { requestedRows } from "~/server/db/helpers/requested";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";

/** Resolve the same current-field authority for a batch of correction candidates. */
export async function cubbyHeldFields(
  db: Database,
  inputs: readonly {
    id: string;
    entity: ShortcodeEntity;
    recordId: string;
    field: string;
  }[],
): Promise<Set<string>> {
  const groups = new Map<ShortcodeEntity, (typeof inputs)[number][]>();
  for (const input of inputs) {
    const group = groups.get(input.entity) ?? [];
    group.push(input);
    groups.set(input.entity, group);
  }
  const results = await Promise.all(
    [...groups].map(async ([entity, group]) => {
      const request = requestedRows(
        group.map((item) => ({
          id: item.id,
          recordId: item.recordId,
          field: item.field,
        })),
        { id: "uuid", recordId: "uuid", field: "text" },
        "r",
      );
      const table = SHORTCODE_TABLE[entity];
      const result = await unwrapDb(db).execute<{ id: string }>(sql`
      SELECT r.id::text AS id FROM ${request.from}
      JOIN ${table} t ON t.id = r."recordId"
      JOIN LATERAL (
        SELECT a.id, a.authority, a."createdAt", a.changes->r.field->'to' AS value
        FROM "AuditLog" a WHERE a."entityKind" = ${entity} AND a."entityId" = r."recordId"
          AND a.action = ${auditLogActionSchema.enum.update} AND a.changes ? r.field
        ORDER BY a."createdAt" DESC, a.id DESC LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT s.id, EXISTS (SELECT 1 FROM jsonb_to_recordset(s.decisions)
          member(authority text, verdict text, "createdAt" text)
          WHERE member.authority = ${feedbackAuthority.enum.member} AND member.verdict = ${feedbackVerdict.enum.correct}
            AND member."createdAt"::timestamptz >= (s."acceptanceReceipt"->>'acceptedAt')::timestamptz) AS kept
        FROM "Suggestion" s WHERE latest.authority = ${auditAuthoritySchema.enum.automatic}
          AND s.family = ${suggestionFamily.enum.field} AND s.entity = ${entity}
          AND s."recordId" = r."recordId" AND s.field = r.field
          AND s."acceptanceReceipt"->'auditIds' ? latest.id::text
        ORDER BY s."createdAt" DESC LIMIT 1
      ) receipt ON true
      WHERE latest.value IS NOT DISTINCT FROM to_jsonb(t)->r.field
        AND ((latest.authority = ${auditAuthoritySchema.enum.released} AND to_jsonb(t)->r.field IS NOT NULL AND to_jsonb(t)->r.field <> 'null'::jsonb AND to_jsonb(t)->r.field <> '""'::jsonb)
          OR (latest.authority = ${auditAuthoritySchema.enum.automatic} AND receipt.id IS NOT NULL AND NOT receipt.kept))
    `);
      return result.rows.map((row) => row.id);
    }),
  );
  return new Set(results.flat());
}
