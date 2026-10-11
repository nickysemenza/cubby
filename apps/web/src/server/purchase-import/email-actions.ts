import type { ActorContext } from "@cubby/schemas/context";
import type { EmailImportInput } from "@cubby/schemas/email-actions";
import { parseShortcodeFor, runEntityId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";

import { getPurchaseAgentQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  ledgerParty,
  email as emailTable,
  orderMail,
  run,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

import { hasRetainedEmailImportContent } from "./email-content";
import { startMailImport } from "./mail-import-run";

export async function startEmailImport(
  db: Database,
  input: EmailImportInput,
  actor: ActorContext,
  queue = getPurchaseAgentQueue(),
) {
  if (actor.runId)
    throw new Error("Only a member can explicitly authorize an Email import.");
  const [selected] = await getDb(db)
    .select({
      email: emailTable,
      content: orderMail.content,
      rawChecksum: orderMail.rawChecksum,
    })
    .from(emailTable)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, emailTable.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        notDeleted(ledgerParty),
      ),
    )
    .leftJoin(orderMail, eq(orderMail.id, emailTable.orderMailId))
    .where(
      and(
        eq(emailTable.shortcode, parseShortcodeFor("email", input.id)),
        notDeleted(emailTable),
      ),
    )
    .limit(1);
  if (!selected) throw new Error("Email was not found for this member.");
  const email = selected.email;
  if (
    email.checksum !== input.expectedChecksum ||
    selected.rawChecksum !== input.expectedChecksum
  )
    throw new Error("Email evidence changed; refresh before importing.");
  if (
    email.classification === "unrelated" ||
    ["deleted", "excluded"].includes(email.status)
  )
    throw new Error(
      "This Email needs a relevance resolution before importing.",
    );
  if (
    !email.orderMailId ||
    !(await hasRetainedEmailImportContent(
      getDb(db),
      email.orderMailId,
      selected.content,
    ))
  )
    throw new Error(
      "Email content is unavailable; retrieve and reclassify its original first.",
    );
  if (!queue) throw new Error("Purchase agent queue is unavailable.");
  const admitted = await startMailImport(
    db,
    {
      ledgerPartyId: email.ledgerPartyId,
      userId: actor.userId,
      messageIds: [email.orderMailId],
      expectedChecksums: [
        { orderMailId: email.orderMailId, checksum: input.expectedChecksum },
      ],
    },
    queue,
  );
  const runs = admitted.length
    ? await getDb(db)
        .select({ id: run.id, shortcode: run.shortcode })
        .from(run)
        .where(
          inArray(
            run.id,
            admitted.map((item) => runEntityId.parse(item.runId)),
          ),
        )
    : [];
  return {
    runIds: admitted.map((item) => {
      const code = runs.find((row) => row.id === item.runId)?.shortcode;
      if (!code) throw new Error("Email import Run was not persisted.");
      return code;
    }),
  };
}
