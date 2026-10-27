import { entitySchema } from "@cubby/schemas/entity";
import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import { related } from "~/server/db/helpers/related";
import { email, entityAttachment, product } from "~/server/db/schema";
import { workPurchaseSourceOwners } from "~/server/domains/purchase/repo/work-owners";

/** Source-document attachments take precedence over a public representative copy. */
export const workImageOwners = (id: SQL): SQL => sql`ARRAY(
  SELECT DISTINCT owner FROM "EntityAttachment" attachment
  CROSS JOIN LATERAL (
    SELECT CASE WHEN cardinality(scope.owners) > 0 THEN scope.owners ELSE ARRAY[NULL::uuid] END AS owners
    FROM (SELECT CASE attachment."entityKind"
      WHEN ${entitySchema.enum.purchase} THEN ${workPurchaseSourceOwners(sql`attachment."entityId"`)}
      WHEN ${entitySchema.enum.email} THEN ARRAY(SELECT message."ledgerPartyId" FROM "Email" message WHERE message.id = attachment."entityId" AND ${notDeleted(alias(email, "message"))})
    END AS owners) scope
  ) source
  CROSS JOIN LATERAL unnest(source.owners) owner
  WHERE attachment."imageId" = ${id} AND ${notDeleted(alias(entityAttachment, "attachment"))}
    AND attachment."entityKind" IN (${entitySchema.enum.purchase}, ${entitySchema.enum.email})
)`;

export const workImageIsShared = (id: SQL): SQL =>
  sql`NOT ${related(
    entityAttachment,
    (attachment) => sql`${attachment.imageId} = ${id}`,
  )
    .where(
      (attachment) =>
        sql`${attachment.entityKind} IN (${entitySchema.enum.purchase}, ${entitySchema.enum.email})`,
    )
    .exists()} AND ${related(
    entityAttachment,
    (attachment) => sql`${attachment.imageId} = ${id}`,
  )
    .where(
      (attachment) =>
        sql`${attachment.entityKind} = ${entitySchema.enum.product}`,
    )
    .join(
      product,
      (item, attachment) => sql`${item.id} = ${attachment.entityId}`,
    )
    .exists()}`;
