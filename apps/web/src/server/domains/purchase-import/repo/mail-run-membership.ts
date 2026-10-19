import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import {
  mailResearchRunInput,
  runInputsErased,
} from "@cubby/schemas/run-fields";
import { and, eq, inArray } from "drizzle-orm";

import {
  type RepositoryQueryClient as DrizzleClient,
  type RepositoryQueryTransaction as DrizzleTransaction,
} from "~/server/db/repository-access.boundary";
import { email as emailTable, run } from "~/server/db/retained-tables";
import type { RetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { createAppError } from "~/server/errors/app-error";

/**
 * The admitted source roster is Run input: admission freezes it and a
 * supporting admission only appends. Current Email status only describes
 * each source's outcome.
 */
export async function readMailRunSources(
  client: DrizzleClient | DrizzleTransaction,
  runId: RunId,
) {
  return (await readMailRunRoster(client, runId)) ?? [];
}

/** A Mail import Run's admitted sources (empty once erased); null for any other Run. */
export async function readMailRunRoster(
  client: DrizzleClient | DrizzleTransaction,
  runId: RunId,
) {
  const [owner] = await client
    .select({
      input: run.input,
      purpose: run.purpose,
      retirementReason: run.retirementReason,
    })
    .from(run)
    .where(eq(run.id, runId));
  if (owner?.purpose !== "mail_import") return null;
  // An erased Run's roster is NULL and admits no sources. A live Run with a
  // missing roster still fails the parse below.
  if (runInputsErased(owner.retirementReason) && owner.input === null)
    return [];
  const frozen = mailResearchRunInput.parse(owner.input).sources;
  const messages = await client
    .select()
    .from(emailTable)
    .where(
      inArray(
        emailTable.orderMailId,
        frozen.map((source) => source.orderMailId),
      ),
    );
  return frozen.map((source, position) => {
    const email = messages.find(
      (message) => message.orderMailId === source.orderMailId,
    );
    if (!email)
      throw new Error("An admitted Email is missing its durable identity.");
    return {
      ...source,
      position,
      email,
      owned: email.runId === runId,
      unchanged: email.checksum === source.checksum,
    };
  });
}

export async function assertMailRunMembership(
  client: DrizzleClient | DrizzleTransaction,
  runId: RunId,
  orderMailId: string,
) {
  const source = (await readMailRunSources(client, runId)).find(
    (item) => item.orderMailId === orderMailId,
  );
  if (!source?.owned)
    throw new Error(
      "This Mail import Run did not admit that Email; resolve only its own messages.",
    );
  if (!source.unchanged)
    throw new Error(
      "Admitted Email evidence changed; reconcile it before importing.",
    );
  return source;
}

/**
 * Reading is not writing: under a Mail import Run, Pi may read its member's
 * retained originals from any mailbox the Run admitted, while every mutation
 * still requires roster membership.
 */
export async function assertMailRunReadAuthority(
  client: DrizzleClient | DrizzleTransaction,
  runId: RunId,
  mail: Pick<RetainedMail, "id" | "ledgerPartyId" | "mailboxId">,
) {
  const sources = await readMailRunSources(client, runId);
  const admitted = sources.find((source) => source.orderMailId === mail.id);
  if (admitted?.owned) return { admitted: true };
  const [owner] = await client
    .select({ ledgerPartyId: run.ledgerPartyId })
    .from(run)
    .where(eq(run.id, runId));
  if (
    owner?.ledgerPartyId !== mail.ledgerPartyId ||
    !sources.some((source) => source.email.mailboxId === mail.mailboxId)
  )
    throw new Error(
      "This Mail import Run reads only its member's Emails from the mailboxes it admitted.",
    );
  return { admitted: false };
}

/**
 * Append one supporting original to a running Mail import Run's roster. The
 * caller has already established same-purchase identity and recipient
 * attribution; this enforces ownership, current evidence and the roster bound.
 */
export async function admitSupportingMailSource(
  // Row locks below need the caller's transaction.
  tx: DrizzleClient | DrizzleTransaction,
  runId: RunId,
  mail: Pick<
    RetainedMail,
    "id" | "ledgerPartyId" | "mailboxId" | "messageId" | "rawChecksum"
  >,
) {
  const [owner] = await tx
    .select()
    .from(run)
    .where(eq(run.id, runId))
    .for("update");
  if (
    owner?.purpose !== "mail_import" ||
    owner.status !== "running" ||
    owner.retiredAt ||
    owner.deletedAt ||
    owner.ledgerPartyId !== mail.ledgerPartyId
  )
    throw new Error(
      "Only a running Mail import Run of this member admits Email.",
    );
  const roster = mailResearchRunInput.parse(owner.input);
  if (roster.sources.some((source) => source.orderMailId === mail.id)) {
    await assertMailRunMembership(tx, runId, mail.id);
    return;
  }
  if (roster.sources.length >= 50)
    throw createAppError(
      "MAIL_SOURCE_ADMISSION_REFUSED",
      "This Mail import Run already holds fifty Emails; the supporting original waits for a later import.",
    );
  const [message] = await tx
    .select()
    .from(emailTable)
    .where(
      and(
        eq(emailTable.ledgerPartyId, mail.ledgerPartyId),
        eq(emailTable.provider, "gmail"),
        eq(emailTable.mailboxId, mail.mailboxId),
        eq(emailTable.messageId, mail.messageId),
        eq(emailTable.orderMailId, mail.id),
      ),
    )
    .for("update");
  if (
    !message ||
    message.deletedAt ||
    message.checksum !== mail.rawChecksum ||
    message.classification !== "related" ||
    message.contentClearedAt ||
    !["pending", "blocked"].includes(message.status)
  )
    throw createAppError(
      "MAIL_SOURCE_ADMISSION_REFUSED",
      `A supporting original must be an unchanged, related Email no import has settled; ${mail.messageId} is ${message ? `${message.deletedAt ? "deleted" : message.status}, classified ${message.classification ?? "unclassified"}${message.checksum === mail.rawChecksum ? "" : ", changed since read"}${message.contentClearedAt ? ", content cleared" : ""}` : "not a retained Email"}.`,
    );
  if (message.runId) {
    const [current] = await tx
      .select({ retiredAt: run.retiredAt, deletedAt: run.deletedAt })
      .from(run)
      .where(eq(run.id, runEntityId.parse(message.runId)));
    if (current && !current.retiredAt && !current.deletedAt)
      throw new Error(
        "Another Mail import Run owns that Email; it stays with that Run.",
      );
  }
  await tx
    .update(run)
    .set({
      input: mailResearchRunInput.parse({
        ...roster,
        sources: [
          ...roster.sources,
          { orderMailId: mail.id, checksum: mail.rawChecksum },
        ],
      }),
      updatedAt: new Date(),
    })
    .where(eq(run.id, runId));
  await tx
    .update(emailTable)
    .set({ runId, status: "researching", updatedAt: new Date() })
    .where(eq(emailTable.id, message.id));
}

/** An explicit member restart transfers only the original frozen roster, never discovery's pending queue. */
export async function transferMailRunSources(
  tx: DrizzleTransaction,
  fromRunId: RunId,
  toRunId: RunId,
  selected?: readonly string[],
) {
  const sources = (await readMailRunSources(tx, fromRunId)).filter(
    (source) => !selected || selected.includes(source.orderMailId),
  );
  if (
    !sources.length ||
    sources.some((source) => !source.owned || !source.unchanged)
  )
    throw new Error(
      "Mail restart evidence or ownership changed; reconcile the original Run.",
    );
  const assigned = await tx
    .update(emailTable)
    .set({ runId: toRunId, status: "researching", updatedAt: new Date() })
    .where(
      and(
        eq(emailTable.runId, fromRunId),
        inArray(
          emailTable.id,
          sources.map((source) => source.email.id),
        ),
      ),
    )
    .returning({ id: emailTable.id });
  if (assigned.length !== sources.length)
    throw new Error("Mail successor ownership transfer is incomplete.");
}
