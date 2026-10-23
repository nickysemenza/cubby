import { sql, type SQLWrapper } from "drizzle-orm";

/** Exactly the ECMAScript String.trim whitespace set used at external ingress. */
export const trimBrandNameSql = (value: SQLWrapper) =>
  sql`btrim(${value}, chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279))`;
