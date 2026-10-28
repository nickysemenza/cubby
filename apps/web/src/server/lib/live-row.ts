import { isNull, type SQL, sql } from "drizzle-orm";

/** Schema-free liveness for an SQL relation's declared alias, quoted as one identifier. */
export const liveAliasSql = (alias: string): SQL =>
  isNull(sql`${sql.identifier(alias)}.${sql.identifier("deletedAt")}`);

/** Internal SQL-text composers pass an already quoted/declared alias, never member input. */
export const liveAliasSqlText = (alias: string): string =>
  `${alias}."deletedAt" IS NULL`;
