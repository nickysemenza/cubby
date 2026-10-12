import type { Entity } from "@cubby/schemas/entity";
import type { WorkQueueRow } from "@cubby/schemas/work-queue";
import { sql, type SQL } from "drizzle-orm";

type Candidate = Pick<
  WorkQueueRow,
  "source" | "kind" | "reason" | "nextAction"
>;

export const workQueueCandidate = (
  entity: Entity,
  table: SQL,
  id: SQL,
  name: SQL,
  owners: SQL,
  where: SQL | undefined,
  details: Candidate,
  key: string,
  shared: boolean | SQL = false,
): SQL => sql`SELECT ${entity}::text AS entity, ${id}::text AS id,
  ${name}::text AS name, ${key}::text || ':' || ${id}::text AS key,
  ${details.source}::text AS source, ${details.kind}::text AS kind,
  ${details.reason}::text AS reason, ${details.nextAction}::text AS "nextAction",
  ${owners}::uuid[] AS owners, ${shared}::boolean AS shared, NULL::text AS "problemKey"
  FROM ${table} WHERE ${where ?? sql`true`}`;

export const workDiagnosticCandidate = (
  problemKey: string,
  key: string,
  name: string,
  owners: SQL,
  details: Candidate,
  shared: boolean | SQL = false,
): SQL => sql`SELECT NULL::text AS entity, NULL::text AS id,
  ${name}::text AS name, ${key}::text AS key,
  ${details.source}::text AS source, ${details.kind}::text AS kind,
  ${details.reason}::text AS reason, ${details.nextAction}::text AS "nextAction",
  ${owners}::uuid[] AS owners, ${shared}::boolean AS shared, ${problemKey}::text AS "problemKey"`;
