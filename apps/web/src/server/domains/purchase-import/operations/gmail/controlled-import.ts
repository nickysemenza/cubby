import type { ActorContext } from "@cubby/schemas/context";
import {
  controlledMailImportInput,
  controlledMailImportOutput,
  mailMatchPreview,
  type MailMatchPreview,
  type ControlledMailImportInput,
  type ControlledMailImportOutput,
} from "@cubby/schemas/mail-coverage-control";
import { mailboxDiscoveryProgress } from "@cubby/schemas/mailbox-research";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { ledgerParty, run, vendor } from "~/server/db/schema";
import {
  findControlledMailImport,
  type ControlledMailRequest,
} from "~/server/domains/purchase-import/repo/controlled-mail-import";
import { gmailProviderForUser } from "~/server/domains/purchase-import/repo/gmail/provider";
import { listMemberMailboxes } from "~/server/domains/purchase-import/repo/gmail/targets";
import { vendorSearchTerms } from "~/server/domains/purchase-import/repo/gmail/vendor-identity";
import {
  mailSearchDateRange,
  eligibleMailSearchQuery,
  vendorMailQueries,
} from "~/server/domains/purchase-import/repo/gmail/vendor-mail-scope";
import { setMailImport } from "~/server/domains/purchase-import/repo/mail-import-settings";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { recordPaidGrant } from "~/server/domains/run/repo/paid-grant";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

/** Promote only after the current discovery has committed its final page. */
export async function launchQueuedControlledMailImport(
  db: Database,
  mailboxId: string,
): Promise<ControlledMailRequest | null> {
  return withTransactionDatabase(db, async (tx) => {
    const control = await findControlledMailImport(tx, mailboxId);
    if (
      !control ||
      !control.ledgerPartyId ||
      control.status !== "paused" ||
      control.failureCode !== "controlled_mail_queued"
    )
      return control;
    const [active] = await getDb(tx)
      .select({ id: run.id })
      .from(run)
      .where(
        and(
          eq(run.purpose, "mail_discovery"),
          eq(run.ledgerPartyId, control.ledgerPartyId),
          eq(run.status, "running"),
          sql`${run.input}->>'mailboxId' = ${mailboxId}`,
          notDeleted(run),
        ),
      )
      .limit(1);
    if (active) return control;
    await launchWorkflowRun(tx, {
      runId: control.id,
      purpose: "mail_discovery",
    });
    return { ...control, status: "running" as const };
  });
}

async function selectedMailScope(
  db: Database,
  actor: ActorContext,
  input: ControlledMailImportInput,
): Promise<{
  seller: typeof vendor.$inferSelect;
  mailbox: Awaited<ReturnType<typeof listMemberMailboxes>>[number];
}> {
  const mailbox = (await listMemberMailboxes(db)).find(
    (target) =>
      target.userId === actor.userId && target.mailboxId === input.mailboxId,
  );
  if (!mailbox)
    throw new Error("Selected mailbox is not connected to this member.");
  const vendorId = await resolveOrThrow(db, "vendor", input.vendorId);
  const [seller] = await getDb(db)
    .select()
    .from(vendor)
    .where(
      and(
        eq(vendor.id, vendorId),
        notDeleted(vendor),
        isNull(vendor.systemKey),
      ),
    )
    .limit(1);
  if (!seller)
    throw new Error("Choose a live Vendor with a mail search identity.");
  return { seller, mailbox };
}

export async function startControlledMailImport(
  db: Database,
  actor: ActorContext,
  submitted: ControlledMailImportInput,
): Promise<ControlledMailImportOutput> {
  const input = controlledMailImportInput.parse(submitted);
  const { seller, mailbox } = await selectedMailScope(db, actor, input);
  // A new request must find mail received since a prior search completed.
  // Frozen request keys resume on replay without resetting canonical cursors.
  const controlKey = crypto.randomUUID();
  const queries = vendorMailQueries(seller.id, vendorSearchTerms(seller)).map(
    (query) => ({
      key:
        input.from || input.to
          ? `${query.key}:range:${input.from ?? ""}:${input.to ?? ""}:controlled:${controlKey}`
          : `${query.key}:controlled:${controlKey}`,
      query: mailSearchDateRange(query.query, input),
    }),
  );
  if (!queries.length)
    throw new Error(
      "This Vendor has no verified sender or website domain to search.",
    );
  await withTransactionDatabase(db, async (tx) => {
    // Match automatic admission's lock order: member, then mailbox settings.
    await getDb(tx)
      .select({ id: ledgerParty.id })
      .from(ledgerParty)
      .where(eq(ledgerParty.id, mailbox.ledgerPartyId))
      .for("no key update");
    const existing = await findControlledMailImport(tx, mailbox.mailboxId);
    if (existing)
      throw new Error(
        `A controlled import for this mailbox already exists: ${existing.shortcode}.`,
      );
    await setMailImport(
      tx,
      { mailboxId: input.mailboxId, enabled: false },
      { kind: "controlled_pause" },
    );
    // The completed form avoids the active-discovery constraint; this
    // transaction publishes its paused request and frozen inputs together.
    const id = await ensureRun(
      tx,
      { ...actor, runId: null },
      {
        purpose: "mail_discovery",
        trigger: "manual",
        status: "completed",
        execution: false,
        notes: `Import mail for ${seller.name}`,
        input: {
          emailAuditVersion: 1,
          mailboxId: input.mailboxId,
          executionPolicy: "import",
          scopedQueries: queries,
          controlled: { from: input.from, to: input.to },
        },
        progress: mailboxDiscoveryProgress.parse({
          attempt: 0,
          phase: "listing",
        }),
      },
    );
    await getDb(tx)
      .update(run)
      .set({
        status: "paused",
        endedAt: null,
        vendorId: seller.id,
        failureCode: "controlled_mail_queued",
      })
      .where(eq(run.id, id));
    // This grant permits paid AI only within the household budget.
    await recordPaidGrant(tx, actor, { runId: id });
  });
  const control = await launchQueuedControlledMailImport(db, input.mailboxId);
  if (!control) throw new Error("The controlled import request was not saved.");
  return controlledMailImportOutput.parse({
    run: control.shortcode,
    state: control.status === "running" ? "running" : "queued",
  });
}

/** One union search avoids double-counting messages matching several senders. */
export async function previewControlledMailMatches(
  db: Database,
  actor: ActorContext,
  submitted: ControlledMailImportInput,
): Promise<MailMatchPreview> {
  const input = controlledMailImportInput.parse(submitted);
  const { seller } = await selectedMailScope(db, actor, input);
  const queries = vendorMailQueries(seller.id, vendorSearchTerms(seller));
  if (!queries.length)
    throw new Error(
      "This Vendor has no verified sender or website domain to search.",
    );
  const query = eligibleMailSearchQuery(
    mailSearchDateRange(
      queries.map((entry) => `(${entry.query})`).join(" OR "),
      input,
    ),
  );
  const provider = await gmailProviderForUser(
    db,
    actor.userId,
    input.mailboxId,
  );
  const page = await provider.listMessages({ query, maxResults: 100 });
  return mailMatchPreview.parse({
    query,
    matchedMessages: page.nextPageToken
      ? page.resultSizeEstimate === undefined
        ? null
        : Math.max(page.resultSizeEstimate, page.messages?.length ?? 0)
      : (page.messages?.length ?? 0),
    approximate: Boolean(page.nextPageToken),
    checkedAt: new Date().toISOString(),
  });
}
