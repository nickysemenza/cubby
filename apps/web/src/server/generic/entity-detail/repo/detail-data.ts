import { connectionCatalog } from "@cubby/schemas/connected-views";
import type { Entity } from "@cubby/schemas/entity";
import {
  detailActivityEventSchema,
  detailActivityInputSchema,
  detailActivityOutputSchema,
  monthlyExpenseSpendOutputSchema,
  type DetailActivityInput,
  type DetailActivityPage,
  type MonthlyExpenseSpend,
  type MonthlyExpenseSpendInput,
} from "@cubby/schemas/entity-detail-data";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { decodeBase64UrlText, encodeBase64Url } from "@cubby/shared/base64";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { actualExpenseSql } from "~/server/db/helpers/predicates";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import { compiledConnectedRoutes } from "~/server/generic/entity-links/repo/connected-records";

const cursorSchema = z
  .object({ date: z.string().datetime(), id: z.string() })
  .strict();
const activityRowSchema = z.object({
  id: z.string(),
  kind: z.enum(["record", "change"]),
  entity: z.string(),
  shortcode: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  date: z.string().datetime(),
  allDay: z.boolean(),
  amountCents: z.coerce.number().int().nullable(),
});

function root(entity: Entity, shortcode: string) {
  const table = entityManifest[entity].dbTable;
  if (!table) throw new Error(`No local table for ${entity}`);
  return {
    from: sql`${sql.identifier(table)} s`,
    where: sql`s."shortcode" = ${shortcode} ${entityManifest[entity].softDelete ? sql`AND s."deletedAt" IS NULL` : sql``}`,
  };
}

function viewTarget(entity: Entity, viewKey: string): Entity {
  const target = connectionCatalog.resolve(entity, viewKey)?.target;
  if (!target) throw new Error(`Unknown detail view ${entity}.${viewKey}`);
  return target;
}

/** Current household calendar month plus its eleven predecessors; actual costs only. */
export async function getMonthlyExpenseSpend(
  db: Database,
  input: MonthlyExpenseSpendInput,
  today = householdLocalDate(),
): Promise<MonthlyExpenseSpend> {
  const { entityKind, entityId } = input.source;
  const charts = entitySummary[entityKind].detail.summary.filter(
    (slot) => slot.kind === "chart",
  );
  if (input.viewKey === undefined && charts.length > 1)
    throw new Error(
      `Ambiguous monthly expense chart for ${entityKind}; provide viewKey`,
    );
  const chart =
    input.viewKey === undefined
      ? charts[0]
      : charts.find((slot) => slot.viewKey === input.viewKey);
  if (!chart)
    throw new Error(
      `No monthly expense chart declared for ${entityKind}.${input.viewKey ?? ""}`,
    );
  if (viewTarget(entityKind, chart.viewKey) !== "expense")
    throw new Error(
      `Monthly spend must target Expense: ${entityKind}.${chart.viewKey}`,
    );
  const source = root(entityKind, entityId);
  const routes = compiledConnectedRoutes(entityKind, chart.viewKey);
  if (!routes.length)
    throw new Error(
      `No traversable Expense paths for ${entityKind}.${chart.viewKey}`,
    );
  const lines = routes.map(
    (route) => sql`
    SELECT DISTINCT t."id", t."date", t."cost"
    FROM ${source.from} ${route.traversal.joins}
    WHERE ${source.where} AND ${sql.raw(actualExpenseSql("t"))}
  `,
  );
  const result = await unwrapDb(db).execute(sql`
    WITH months AS (
      SELECT generate_series(date_trunc(${"month"}, ${today}::date) - interval '11 months', date_trunc(${"month"}, ${today}::date), interval '1 month')::date AS month
    ), lines AS (${sql.join(lines, sql` UNION `)})
    SELECT to_char(months.month, 'YYYY-MM') AS month,
      coalesce(round(sum(lines."cost")::numeric * 100), 0)::float AS cents
    FROM months LEFT JOIN lines ON lines."date" >= months.month AND lines."date" < months.month + interval '1 month'
    GROUP BY months.month ORDER BY months.month
  `);
  return monthlyExpenseSpendOutputSchema.parse(result.rows);
}

/** Keyset pagination is applied after deduplicating and merging every source. */
export async function getDetailActivity(
  db: Database,
  rawInput: DetailActivityInput,
): Promise<DetailActivityPage> {
  const input = detailActivityInputSchema.parse(rawInput);
  const { entityKind, entityId } = input.source;
  const source = root(entityKind, entityId);
  const queries: SQL[] = [];
  for (const entry of entitySummary[entityKind].detail.activityRelations) {
    const target = viewTarget(entityKind, `relation:${entry.relation}`);
    if (input.entity && input.entity !== target) continue;
    const date = sql`t.${sql.identifier(entry.dateField)}`;
    // A calendar-date field reads back as UTC midnight; flag it so clients
    // format the day without a zone shift.
    const fields: readonly { key: string; kind: string }[] =
      entityFieldModels[target].fields;
    const allDay =
      fields.find((field) => field.key === entry.dateField)?.kind === "date";
    for (const route of compiledConnectedRoutes(
      entityKind,
      `relation:${entry.relation}`,
    )) {
      queries.push(sql`
        SELECT DISTINCT ${`record:${target}:`} || t."shortcode" AS id, ${detailActivityEventSchema.shape.kind.enum.record}::text AS kind,
          ${target}::text AS entity, t."shortcode", ${labelSql(target, "t")} AS title,
          NULL::text AS subtitle, ${date}::timestamp AS date,
          ${allDay}::boolean AS "allDay",
          ${target === "expense" ? sql`round(t."cost"::numeric * 100)::float` : sql`NULL::float`} AS "amountCents"
        FROM ${source.from} ${route.traversal.joins}
        WHERE ${source.where} AND ${date} IS NOT NULL
      `);
    }
  }
  if (!input.entity || input.entity === entityKind) {
    queries.push(sql`
      SELECT 'change:' || a."id"::text AS id, ${detailActivityEventSchema.shape.kind.enum.change}::text AS kind,
        ${entityKind}::text AS entity, s."shortcode", a."action" AS title,
        (SELECT string_agg(key, ', ' ORDER BY key) FROM jsonb_object_keys(a."changes") key) AS subtitle,
        a."createdAt" AS date, false AS "allDay", NULL::float AS "amountCents"
      FROM ${source.from} JOIN "AuditLog" a ON a."entityId" = s."id" AND a."entityKind" = ${entityKind}
      WHERE ${source.where}
    `);
  }
  if (!queries.length) return { items: [], nextCursor: null };
  const cursor = input.cursor
    ? cursorSchema.parse(JSON.parse(decodeBase64UrlText(input.cursor)))
    : null;
  const result = await unwrapDb(db).execute(sql`
    WITH events AS (${sql.join(queries, sql` UNION `)})
    SELECT id, kind, entity, shortcode, title, subtitle, "allDay", "amountCents",
      to_char(date, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS date FROM events
    ${cursor ? sql`WHERE (date, id) < (${cursor.date}::timestamptz AT TIME ZONE 'UTC', ${cursor.id})` : sql``}
    ORDER BY date DESC, id DESC LIMIT ${input.limit + 1}
  `);
  const rows = z.array(activityRowSchema).parse(result.rows);
  const items = rows.slice(0, input.limit).map((row) => ({
    ...row,
    date: row.date,
    subtitle: row.subtitle ?? undefined,
    amountCents: row.amountCents ?? undefined,
  }));
  const last = items.at(-1);
  return detailActivityOutputSchema.parse({
    items,
    nextCursor:
      rows.length > input.limit && last
        ? encodeBase64Url(JSON.stringify({ date: last.date, id: last.id }))
        : null,
  });
}
