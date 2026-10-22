/**
 * The persistence side of the mail financial event port. A preparation is an
 * in-process value minted only after declared inference on one exact original;
 * a parsed payload never carries authority. Booking revalidates it against the
 * current retained original inside the writer's transaction.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { FinancialMailEvent } from "@cubby/schemas/financial-mail-event";
import type { EmailId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  type RepositoryQueryTransaction as DrizzleTransaction,
  repositoryQueries as unwrapDb,
} from "~/server/db/repository-access.boundary";
import {
  email as emailTable,
  ledgerParty,
  orderMail,
} from "~/server/db/retained-tables";
import {
  retainedMailJoin,
  retainedMailProjection,
  type RetainedMail,
} from "~/server/domains/mail/repo/retained-mail";
import { wasm } from "~/server/wasm";

export type PreparedMailFinancialEvent = Readonly<{
  event: FinancialMailEvent;
  emailId: EmailId;
  checksum: string;
  /** Every model-copied value the event rests on, verbatim. */
  literals: readonly string[];
}>;

const genuine = new WeakSet<PreparedMailFinancialEvent>();

/** Called only by the service after verified inference in this invocation. */
export function mintPreparedMailFinancialEvent(
  value: PreparedMailFinancialEvent,
): PreparedMailFinancialEvent {
  const prepared = Object.freeze({
    ...value,
    event: Object.freeze({
      ...value.event,
      amount: Object.freeze({ ...value.event.amount }),
    }),
    literals: Object.freeze([...value.literals]),
  });
  genuine.add(prepared);
  return prepared;
}

const collapse = (text: string) => text.replace(/\s+/gu, " ").trim();

/** Readable text of the retained original, the only corpus literals may come from. */
export function mailEvidenceText(content: RetainedMail["content"]) {
  const html = content.bodyHtml
    ? wasm.compact_email_html(content.bodyHtml)
    : null;
  return collapse([content.bodyText, html?.text].filter(Boolean).join("\n"));
}

export function mailEvidenceContains(corpus: string, literal: string) {
  const needle = collapse(literal);
  return needle.length > 0 && corpus.includes(needle);
}

/** The actor's own related, retained original for one Email, optionally locked. */
export async function readMailFinancialSource(
  db: Database | DrizzleTransaction,
  emailId: EmailId,
  actor: Pick<ActorContext, "userId">,
  lock?: "share",
) {
  const parties = unwrapDb(db)
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    );
  const query = unwrapDb(db)
    .select({ mail: retainedMailProjection, message: emailTable })
    .from(emailTable)
    .innerJoin(orderMail, retainedMailJoin)
    .where(
      and(
        eq(emailTable.id, emailId),
        notDeleted(emailTable),
        inArray(emailTable.ledgerPartyId, parties),
      ),
    )
    .limit(1);
  const [row] = await (lock ? query.for(lock, { of: emailTable }) : query);
  if (
    !row ||
    row.message.classification !== "related" ||
    row.message.contentClearedAt ||
    ["excluded", "deleted"].includes(row.message.status) ||
    row.message.checksum !== row.mail.rawChecksum
  )
    return null;
  return row;
}

/**
 * Inside the booking transaction: the preparation must be genuine and its
 * Email unchanged, still related and retained, with every literal still
 * present in the original. Returns the event to book from.
 */
export async function assertMailFinancialEvidenceCurrent(
  tx: Database | DrizzleTransaction,
  preparation: PreparedMailFinancialEvent,
  actor: Pick<ActorContext, "userId">,
): Promise<FinancialMailEvent> {
  if (!genuine.has(preparation))
    throw new Error(
      "Mail financial evidence must come from this invocation's verified preparation.",
    );
  const current = await readMailFinancialSource(
    tx,
    preparation.emailId,
    actor,
    "share",
  );
  if (!current || current.mail.rawChecksum !== preparation.checksum)
    throw new Error(
      "The Email changed or is no longer retained; prepare its financial evidence again.",
    );
  const corpus = mailEvidenceText(current.mail.content);
  if (
    !preparation.literals.every((literal) =>
      mailEvidenceContains(corpus, literal),
    )
  )
    throw new Error(
      "The Email no longer shows the financial evidence its preparation read.",
    );
  return preparation.event;
}
