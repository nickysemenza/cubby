import { readFileSync } from "node:fs";

/** The migration owns this projection; inspection and predecessor tests use its exact bytes. */
export function acceptedInputCutoverSql(): string {
  return readFileSync(
    new URL(
      "../drizzle/20261114000000_accepted_input_cutover/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
}

export function acceptedInputCutoverSelect(): string {
  const sql = acceptedInputCutoverSql();
  const projection = sql
    .split("-- cutover:select:start\n")[1]
    ?.split("\n-- cutover:select:end")[0];
  if (!projection?.startsWith("WITH RECURSIVE "))
    throw new Error("Cutover SELECT markers are missing");
  return projection;
}
