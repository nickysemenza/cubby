import type { ActorContext } from "@cubby/schemas/context";

import type { Database } from "~/server/db/database";
import type { emailFinancialAssociation } from "~/server/db/retained-tables";
import { decide, recordSubject } from "~/server/kernel/api";

export async function decideEmailFinancialAssociation(
  db: Database,
  actor: ActorContext,
  input: Pick<
    typeof emailFinancialAssociation.$inferInsert,
    | "emailId"
    | "evidenceChecksum"
    | "transactionId"
    | "reviewedAccountId"
    | "sourceAccountLabel"
    | "reviewReason"
  >,
) {
  await decide(db, actor, [
    {
      channel: "assignment",
      kind: "set",
      subject: recordSubject("email", input.emailId),
      field: `financial:${input.evidenceChecksum}:${input.transactionId}`,
      value: input,
      scopes: [{ kind: "emailState", key: input.emailId }],
    },
  ]);
}
