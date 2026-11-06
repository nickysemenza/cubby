/**
 * The assembled Drizzle model, every table and relation, for client
 * construction, schema drift checks and whole-schema enumeration. Import a
 * table by name from `schema.ts`; the Job table belongs to
 * generic/jobs, and the import fence also rejects them as `schema.<table>`.
 */
export * as drizzleSchema from "./schema";
