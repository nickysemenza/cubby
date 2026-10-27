import type { Entity } from "@cubby/schemas/entity";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { sql } from "drizzle-orm";

import { repositoryReadPorts } from "~/server/entity-kernel/repo/read-ports";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";

export const labelSql = (entity: Entity, alias: string) => {
  const prefix = alias ? `${alias}.` : "";
  const column = (name: string) => sql.raw(`${prefix}"${name}"`);
  const title = repositoryReadPorts(entity)?.title();
  const table = Object.entries(SHORTCODE_TABLE).find(
    ([key]) => key === entity,
  )?.[1];
  const label =
    title && table
      ? sql`COALESCE((WITH "__label_source" AS (SELECT ${column("id")} AS "id") SELECT ${title} FROM ${table}, "__label_source" WHERE ${table.id} = "__label_source"."id"), ${column("shortcode")})`
      : column("shortcode");
  return entityManifest[entity].softDelete
    ? sql`${label} || CASE WHEN ${column("deletedAt")} IS NOT NULL THEN ' (deleted)' ELSE '' END`
    : label;
};
