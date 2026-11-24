import { AsyncLocalStorage } from "node:async_hooks";

import type { EmailExecutionPolicy } from "@cubby/schemas/email-fields";
import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  boundTransaction,
  databaseForTransaction,
  getDb,
  notDeleted,
  parentTransactionDatabase,
  withTransaction,
} from "~/server/db/helpers";
import {
  email as emailTable,
  emailClassificationObservation,
  ledgerParty,
  run,
} from "~/server/db/schema";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import {
  assertEmailEvidenceScope,
  withEmailEvidenceWrite,
  type EmailEvidenceWriteScope,
} from "~/server/domains/purchase-import/repo/email-evidence-write-scope";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "~/server/domains/purchase-import/repo/mail-source-identity";
import { reportHouseholdBusy } from "~/server/kernel/gate";

/** Refresh does not transfer, repair or readmit an assigned import source. */
async function classificationRefreshDisposition(
  db: Database,
  email: typeof emailTable.$inferSelect,
) {
  if (!email.runId) return "refresh";
  const [owner] = await getDb(db)
    .select()
    .from(run)
    .where(eq(run.id, email.runId))
    .limit(1);
  if (owner?.purpose === "mail_discovery") return "refresh";
  if (
    owner?.purpose !== "mail_import" ||
    owner.ledgerPartyId !== email.ledgerPartyId
  )
    return "historical";
  const frozen = mailResearchRunInput.safeParse(owner.input);
  if (!frozen.success || !email.orderMailId) return "historical";
  const source = frozen.data.sources.find(
    (candidate) =>
      candidate.orderMailId === email.orderMailId &&
      candidate.checksum === email.checksum,
  );
  if (!source) return "historical";
  const [original] = await readRetainedMail(db, {
    ledgerPartyIds: [email.ledgerPartyId],
    mailboxId: email.mailboxId,
    messageId: email.messageId,
    orderMailIds: [source.orderMailId],
  });
  return original?.rawChecksum === source.checksum ? "frozen" : "historical";
}

export async function deferClassificationRefresh(
  db: Database,
  policy: EmailExecutionPolicy,
  email: typeof emailTable.$inferSelect | null,
) {
  if (policy !== "classification_only" || !email?.runId) return false;
  return (await classificationRefreshDisposition(db, email)) !== "refresh";
}

export function emailPublicationChanged(
  current: typeof emailTable.$inferSelect | null,
  expected: typeof emailTable.$inferSelect | null,
) {
  if (!expected) return Boolean(current);
  if (!current) return true;
  const fields = [
    "id",
    "runId",
    "checksum",
    "orderMailId",
    "status",
    "classification",
    "classificationVersion",
    "classificationStage",
    "classificationReason",
  ] as const;
  return (
    fields.some((key) => current[key] !== expected[key]) ||
    current.updatedAt.getTime() !== expected.updatedAt.getTime() ||
    current.contentClearedAt?.getTime() !== expected.contentClearedAt?.getTime()
  );
}

type PublishedObservation = Pick<
  typeof emailClassificationObservation.$inferSelect,
  "id" | "classification" | "stage"
>;

type GmailPublicationContext = {
  scope: EmailEvidenceWriteScope;
  recordObservation: (observation: PublishedObservation | null) => void;
};

/** The transaction of the Gmail publication running in this async context. */
const publications = new AsyncLocalStorage<DrizzleTransaction>();

/**
 * The transaction of the Gmail publication `db` runs inside, if any. A gated
 * writer nested in a publication joins it instead of opening a savepoint:
 * nothing in a publication catches a writer's error, so the whole publication
 * rolls back and a writer savepoint is never rolled back to alone.
 */
export function gmailPublicationTransaction(
  db: Database,
): DrizzleTransaction | undefined {
  const publication = publications.getStore();
  const tx = boundTransaction(db);
  let candidate: Database | undefined = publication && tx ? db : undefined;
  while (candidate && boundTransaction(candidate) !== publication)
    candidate = parentTransactionDatabase(candidate);
  return candidate ? tx : undefined;
}

/**
 * Run a gated writer's `work` joined to its enclosing Gmail publication, or
 * in its own `open` boundary elsewhere. `busy` keeps a member household
 * write's lock-timeout error.
 */
export function joinGmailPublication<T>(
  db: Database,
  work: (tx: DrizzleTransaction) => Promise<T>,
  open: (
    db: Database,
    work: (tx: DrizzleTransaction) => Promise<T>,
  ) => Promise<T>,
  options: { busy?: true } = {},
): Promise<T> {
  const tx = gmailPublicationTransaction(db);
  if (!tx) return open(db, work);
  return options.busy ? reportHouseholdBusy(() => work(tx)) : work(tx);
}

/** Provider/model IO is complete. Admission wins before this publication boundary. */
export async function publishGmailEvidence<T>(
  db: Database,
  input: {
    ledgerPartyId: string;
    mailboxId: string;
    messageId: string;
    runId?: string;
    executionPolicy: EmailExecutionPolicy;
    expected: typeof emailTable.$inferSelect | null;
    /** Extraction-preview publication is auxiliary evidence, not message handling. */
    recordHandlingReceipt?: boolean;
    observationId?: string | null;
    removed?: boolean;
  },
  publish: (
    tx: Database,
    current: typeof emailTable.$inferSelect | null,
    publication: GmailPublicationContext,
  ) => Promise<T>,
  scope?: EmailEvidenceWriteScope,
): Promise<T | null> {
  const initialObservationId = input.observationId ?? null;
  const commitEvidence = async (
    tx: DrizzleTransaction,
    scope: EmailEvidenceWriteScope,
    memberLimits: boolean,
  ) => {
    assertEmailEvidenceScope(databaseForTransaction(tx), scope);
    // Transaction-local: a contended member lock fails fast and frees the
    // socket. An owned scope entered the gate with these member limits.
    if (!memberLimits)
      await tx.execute(sql`SELECT set_config('lock_timeout', '2000', true)`);
    let observationId = initialObservationId;
    let observation: PublishedObservation | null = null;
    const partyId = parseEntityId("ledgerParty", input.ledgerPartyId);
    // Shared: removal, admission and correction lock the owner exclusively and
    // win, while unrelated Emails publish concurrently.
    const [party] = await tx
      .select({ id: ledgerParty.id })
      .from(ledgerParty)
      .where(and(eq(ledgerParty.id, partyId), notDeleted(ledgerParty)))
      .for("share");
    const runIds = [
      ...new Set(
        [input.runId, input.expected?.runId].filter((id): id is string =>
          Boolean(id),
        ),
      ),
    ].map((id) => runEntityId.parse(id));
    // Requester and captured Runs lock in one sorted statement. Publication
    // may update a captured Run, so neither holds it shared. The lock holds
    // the requester's status and identity for the rest of the publication.
    const lockedRuns = runIds.length
      ? await tx
          .select()
          .from(run)
          .where(inArray(run.id, runIds))
          .orderBy(asc(run.id))
          .for("no key update")
      : [];
    const requester = lockedRuns.find((row) => row.id === input.runId);
    if (input.runId)
      (
        await import("~/server/domains/run/repo/execution-context")
      ).assertExecutableRun(requester?.deletedAt ? undefined : requester);
    const decline = async (
      reason: "removed" | "frozen" | "changed",
      _current: typeof emailTable.$inferSelect | null,
    ) => {
      if (input.recordHandlingReceipt !== false)
        await (
          await import("~/server/domains/email/repo/discovery-email-audit")
        ).recordDiscoveryEmailReceipt(databaseForTransaction(tx), {
          ...input,
          observationId,
          outcome: reason,
          run: requester,
        });
      if (input.runId && input.expected) {
        if (requester?.purpose === "mail_reclassify")
          await (
            await import("~/server/domains/purchase-import/repo/gmail/reclassification-receipt")
          ).saveReclassificationReceipt(
            databaseForTransaction(tx),
            input.runId,
            input.expected,
            {
              result: {
                id: (
                  await import("@cubby/schemas/identifiers")
                ).parseShortcodeFor("email", input.expected.shortcode),
                outcome: reason,
                classification: null,
                stage: null,
                conflict: false,
                error: null,
              },
              observationId,
              sourceChecksum: input.expected.checksum,
            },
          );
      }
      return null;
    };
    if (!party) return decline("removed", null);
    const [current] = await tx
      .select()
      .from(emailTable)
      .where(
        and(
          eq(emailTable.ledgerPartyId, partyId),
          eq(emailTable.provider, "gmail"),
          eq(emailTable.mailboxId, input.mailboxId),
          eq(emailTable.messageId, input.messageId),
          notDeleted(emailTable),
        ),
      )
      .for("update")
      .limit(1);
    if (emailPublicationChanged(current ?? null, input.expected))
      return decline(current ? "changed" : "removed", current ?? null);
    const txDb = databaseForTransaction(tx);
    if (
      current?.classificationVersion ===
        HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION ||
      (await deferClassificationRefresh(
        txDb,
        input.executionPolicy,
        current ?? null,
      ))
    )
      return decline("frozen", current ?? null);
    const result = await publications.run(tx, () =>
      publish(txDb, current ?? null, {
        scope,
        recordObservation: (recorded) => {
          observation = recorded;
          observationId = recorded?.id ?? null;
        },
      }),
    );
    if (input.recordHandlingReceipt !== false)
      await (
        await import("~/server/domains/email/repo/discovery-email-audit")
      ).recordDiscoveryEmailReceipt(txDb, {
        ...input,
        observationId,
        outcome: input.removed ? "removed" : undefined,
        run: requester,
        observation,
      });
    if (input.runId && input.expected) {
      if (requester?.purpose === "mail_reclassify") {
        const { reclassificationReceipt, saveReclassificationReceipt } =
          await import("~/server/domains/purchase-import/repo/gmail/reclassification-receipt");
        await saveReclassificationReceipt(
          txDb,
          input.runId,
          input.expected,
          await reclassificationReceipt(
            txDb,
            input.expected,
            observationId,
            result,
            input.removed,
          ),
        );
      }
    }
    return result;
  };
  if (scope !== undefined) {
    // An existing owner must prove its gate; never acquire one after its locks.
    assertEmailEvidenceScope(db, scope);
    return withTransaction(db, (tx) => commitEvidence(tx, scope, false));
  }
  // The owned transaction is this publication alone: any failure rolls it
  // back whole, so it needs no savepoint of its own.
  return withEmailEvidenceWrite(db, (transactionDb, ownedScope) => {
    const tx = boundTransaction(transactionDb);
    if (!tx) throw new Error("Email evidence scope has no open transaction");
    return commitEvidence(tx, ownedScope, true);
  });
}
