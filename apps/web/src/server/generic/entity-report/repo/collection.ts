import type {
  EntityReportInput,
  EntityReportOut,
} from "@cubby/schemas/entity-report";

import type { Database } from "~/server/db";
import { ENTITY_REPORT_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";

/** Collection builders own their supported scope and filter validation. */
export async function buildCollectionReport(
  db: Database,
  input: EntityReportInput,
): Promise<EntityReportOut> {
  const { scope } = input;
  if (scope.kind === "record")
    throw new Error("Expected a collection report scope.");
  if (input.cursor !== undefined)
    throw new Error(
      `${input.slot} does not support a collection report cursor.`,
    );
  const load = Object.entries(ENTITY_REPORT_BINDINGS).find(
    ([key]) => key === scope.entity,
  )?.[1];
  const bindings = load && (await load());
  const builder =
    bindings && "collection" in bindings
      ? Object.entries(bindings.collection).find(
          ([slot]) => slot === input.slot,
        )?.[1]
      : undefined;
  if (!builder)
    throw new Error(
      `${input.slot} does not support this ${scope.kind} ${scope.entity} report scope.`,
    );
  return builder(db, input);
}
