import type { ActorContext } from "@cubby/schemas/context";
import {
  emailImportInput,
  emailImportOut,
  type EmailImportInput,
} from "@cubby/schemas/email-actions";
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
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

import { hasRetainedEmailImportContent } from "./email-content";
import { startMailImport } from "./mail-import-run";

type ImportPorts = { launch?: typeof startMailImport };

/**
 * A member's explicit authorization to import selected Emails. Every Email
 * must be the member's own, unchanged since review, not unrelated, and hold
 * retained content; one refusal launches nothing. The selection reaches one
 * shared launcher, so overlapping source sets return every owning Run.
 */
export async function startEmailImport(
  db: Database,
  rawInput: EmailImportInput,
  actor: ActorContext,
  queue: PurchaseAgentQueueProducer | undefined = getPurchaseAgentQueue(),
  ports: ImportPorts = {},
) {
  const input = emailImportInput.parse(rawInput);
  if (actor.runId)
    throw new Error("Only a member can explicitly authorize an Email import.");
  const ids = input.items.map((item) => item.id);
  if (new Set(ids).size !== ids.length)
    throw new Error("An Email was selected more than once.");
  const selected = await getDb(db)
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
        inArray(
          emailTable.shortcode,
          ids.map((id) => parseShortcodeFor("email", id)),
        ),
        notDeleted(emailTable),
      ),
    );
  const sources = [];
  for (const item of input.items) {
    const row = selected.find(
      (candidate) => candidate.email.shortcode === item.id,
    );
    if (!row) throw new Error(`${item.id} was not found for this member.`);
    const email = row.email;
    if (
      email.checksum !== item.expectedChecksum ||
      row.rawChecksum !== item.expectedChecksum
    )
      throw new Error(`${item.id} evidence changed; refresh before importing.`);
    if (
      email.classification === "unrelated" ||
      ["deleted", "excluded"].includes(email.status)
    )
      throw new Error(
        `${item.id} needs a relevance resolution before importing.`,
      );
    if (
      !email.orderMailId ||
      !(await hasRetainedEmailImportContent(
        getDb(db),
        email.orderMailId,
        row.content,
      ))
    )
      throw new Error(
        `${item.id} content is unavailable; retrieve and reclassify its original first.`,
      );
    sources.push({
      ledgerPartyId: email.ledgerPartyId,
      orderMailId: email.orderMailId,
      checksum: item.expectedChecksum,
    });
  }
  // Ownership already pins the selection to the actor's one member party.
  const [head] = sources;
  if (!head) throw new Error("Select at least one Email.");
  const launch = ports.launch ?? startMailImport;
  if (!ports.launch && !queue)
    throw new Error("Purchase agent queue is unavailable.");
  const admitted = await launch(
    db,
    {
      ledgerPartyId: head.ledgerPartyId,
      userId: actor.userId,
      messageIds: sources.map((source) => source.orderMailId),
      expectedChecksums: sources.map(({ orderMailId, checksum }) => ({
        orderMailId,
        checksum,
      })),
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
  return emailImportOut.parse({
    runIds: admitted.map((item) => {
      const code = runs.find((row) => row.id === item.runId)?.shortcode;
      if (!code) throw new Error("Email import Run was not persisted.");
      return code;
    }),
  });
}
