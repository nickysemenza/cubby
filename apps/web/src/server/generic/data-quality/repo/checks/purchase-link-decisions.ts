import { emailLinkEvidenceKind } from "@cubby/schemas/email-fields";
import { entitySchema } from "@cubby/schemas/entity";
import {
  decisionActorKind,
  decisionChannel,
  decisionKind,
} from "@cubby/schemas/kernel/stage";
import { sql, type SQL } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";
import { sqlEnumConstant } from "~/server/db/sql-enum";

const assignment = sqlEnumConstant(
  decisionChannel,
  decisionChannel.enum.assignment,
);
const set = sqlEnumConstant(decisionKind, decisionKind.enum.set);
const linked = sqlEnumConstant(
  emailLinkEvidenceKind,
  emailLinkEvidenceKind.enum.linked,
);
const dismissed = sqlEnumConstant(
  emailLinkEvidenceKind,
  emailLinkEvidenceKind.enum.dismissed,
);
const member = sqlEnumConstant(
  decisionActorKind,
  decisionActorKind.enum.member,
);
const purchaseKind = sqlEnumConstant(entitySchema, entitySchema.enum.purchase);

/** Read only the current assignment, including an explicit removal of an older pointer. */
// Keep Purchase identity resolution in sync with purchaseReference in domains/email/repo/email-decision-sql.ts.
const purchasePointerSql = (subject: SQL) => sql`(
  SELECT coalesce(target."mergedIntoId", target.id) AS id
  FROM (
    SELECT receipt.kind, receipt.value #>> '{}' AS ref
    FROM "Decision" receipt
    WHERE receipt.subject = ${subject} AND receipt.channel = ${assignment} AND receipt.slot = 'purchaseId'
    ORDER BY receipt.at DESC NULLS LAST, receipt.id DESC NULLS LAST
    LIMIT 1
  ) pointer
  -- includes-deleted: pointers can still resolve through a merged identity.
  JOIN "Entity" target ON target.kind = ${purchaseKind} AND (
    (target.id = CASE WHEN pg_input_is_valid(lower(pointer.ref), pg_typeof(NULL::uuid)::text) THEN lower(pointer.ref)::uuid END
      AND target.id::text = lower(pointer.ref))
    OR target.shortcode = upper(btrim(pointer.ref))
  )
  WHERE pointer.kind = ${set}
)`;

/** Current link facts used by the notice and settlement checks, with Email projection precedence. */
// Keep link precedence in sync with emailLinkDecisionProjection in domains/email/repo/email-decision-sql.ts.
export const purchaseQualityLinkDecisionsSql = (purchaseIds: SQL) => sql`(
  WITH requested AS MATERIALIZED (${purchaseIds}),
  slots AS MATERIALIZED (
    SELECT r.id AS "purchaseId", 'link:' || r.id AS slot,
      CASE WHEN target.id IS NOT NULL THEN true END AS canonical
    FROM requested r
    -- includes-deleted: a tombstoned identity still controls the slot's target.
    LEFT JOIN "Entity" target ON target.id = r.id
    WHERE target."mergedIntoId" IS NULL
    UNION ALL
    SELECT r.id, 'link:' || predecessor.id, false FROM requested r
    -- includes-deleted: a merged Purchase's Decision slot survives under its original id.
    CROSS JOIN LATERAL (
      SELECT e.id FROM "Entity" e WHERE e."mergedIntoId" = r.id OFFSET 0
    ) predecessor
  ), current_links AS MATERIALIZED (
    -- Decision_slot_idx starts with subject. With the subject unknown, scan
    -- link rows once for this page. All subsequent Decision reads know the subject.
    SELECT DISTINCT ON (d.subject, d.slot) d.id, d.subject, d.kind, d."actorKind",
      d.value, slots."purchaseId", slots.canonical
    FROM "Decision" d JOIN slots ON slots.slot = d.slot
    WHERE d.channel = ${assignment} AND d.field LIKE 'link:%' AND d.subject LIKE 'email:%'
      AND EXISTS (SELECT 1 FROM slots)
    ORDER BY d.subject, d.slot, d.at DESC, d.id DESC
  )
  SELECT DISTINCT ON (d.subject, d."purchaseId", coalesce(linked_event.id, (d.value->>'eventId')::uuid))
    d.id, d."purchaseId", coalesce(linked_event.id, (d.value->>'eventId')::uuid) AS "eventId",
    live_email.id AS "emailId", d.value->>${"decision"} AS decision,
    ((d.value->>${"active"})::boolean IS DISTINCT FROM false
      AND live_purchase.id IS NOT NULL AND live_email.id IS NOT NULL
      AND (d."actorKind" = ${member}
        OR coalesce(linked_event.id, (d.value->>'eventId')::uuid) IS NULL
        OR (active_event.id IS NOT NULL AND active_event."supersededAt" IS NULL))
      AND (d.value->>${"decision"} = ${dismissed}
        OR coalesce(event_pointer.id, email_pointer.id) = live_purchase.id)) AS active
  FROM current_links d
  LEFT JOIN "Email" live_email ON live_email.id = substring(d.subject from 7)::uuid AND ${notDeleted("live_email")}
  LEFT JOIN LATERAL (
    SELECT event.id FROM "OrderMailEvent" event
    JOIN LATERAL ${purchasePointerSql(sql`'emailEvent:' || event.id`)} pointer
      ON pointer.id = d."purchaseId"
    WHERE event."orderMailId" = live_email."orderMailId"
      AND d.value->>${"decision"} = ${linked} AND d.canonical IS NOT NULL
  ) linked_event ON true
  LEFT JOIN LATERAL ${purchasePointerSql(sql`'emailEvent:' || coalesce(linked_event.id::text, d.value->>'eventId')`)} event_pointer ON true
  LEFT JOIN LATERAL ${purchasePointerSql(sql`d.subject`)} email_pointer ON true
  LEFT JOIN "OrderMailEvent" active_event ON active_event.id = coalesce(linked_event.id, (d.value->>'eventId')::uuid)
    AND active_event."orderMailId" = live_email."orderMailId"
  LEFT JOIN "Purchase" live_purchase ON live_purchase.id = d."purchaseId" AND ${notDeleted("live_purchase")}
  WHERE d.kind = ${set}
  ORDER BY d.subject, d."purchaseId", coalesce(linked_event.id, (d.value->>'eventId')::uuid),
    active DESC, (d.value->>${"decision"} = ${linked}) DESC, d.canonical DESC, d.id
)`;
