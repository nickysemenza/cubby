import {
  emailImportOutcomeDetail,
  type EmailImportOutcomeDetail,
} from "@cubby/schemas/email-fields";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { inArray, sql, type SQL } from "drizzle-orm";

import { emailReadSnapshot } from "~/server/db/read-snapshot-schema";
import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

/** Outcome and link state are one publication from emailState. */
export const emailImportOutcomeSql = (): SQL<string | null> => sql`(
  SELECT snapshot."relationshipFacts" #>> '{outcome,outcome}' FROM "EmailReadSnapshot" snapshot WHERE snapshot."entityId" = "Email".id
)`;

export async function loadEmailImportOutcomes(
  db: RepositoryQueryInput,
  rows: readonly { id: string; accepted?: boolean | null }[],
): Promise<Map<string, EmailImportOutcomeDetail>> {
  if (!rows.length) return new Map();
  const snapshots = await repositoryQueries(db)
    .select()
    .from(emailReadSnapshot)
    .where(
      inArray(
        emailReadSnapshot.entityId,
        rows.map((row) => parseEntityId("email", row.id)),
      ),
    );
  return new Map(
    snapshots.flatMap((snapshot) => {
      const parsed = emailImportOutcomeDetail.safeParse(
        snapshot.relationshipFacts?.outcome,
      );
      return parsed.success ? [[snapshot.entityId, parsed.data] as const] : [];
    }),
  );
}
