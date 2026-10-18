/**
 * Writer authority for a Mail import Run's mail sources. Pi may read any
 * same-authority original, but importing or linking one requires roster
 * membership: an original found while researching joins the roster only when
 * declared decisions establish the same purchase and the recipient's own
 * transaction. A Run without explicit member selection also needs recipient
 * attribution before an admitted Email becomes a Purchase.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { RunId } from "@cubby/schemas/identifiers";
import type { MailMessageRef } from "@cubby/schemas/mailbox-research";
import { and, eq } from "drizzle-orm";

import type { DecisionPort } from "~/server/ai/decision-model";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { ledgerParty, run as runTable } from "~/server/db/schema";
import {
  readRetainedMail,
  type RetainedMail,
} from "~/server/domains/mail/repo/retained-mail";
import {
  admitSupportingMailSource,
  readMailRunSources,
} from "~/server/domains/purchase-import/repo/mail-run-membership";
import {
  aiCallRunInput,
  ensureRun,
} from "~/server/domains/run/repo/ensure-run";
import { createAppError } from "~/server/errors/app-error";

import { readMailOwnerEvidence } from "../repo/mail-owner";
import {
  describeMailAttribution,
  judgeMailAttributions,
  judgeSameMailPurchase,
  type MailAttribution,
  type MailAttributionJudgment,
} from "../service/mail-source-judgment";

/** `via`: retained Emails connecting this one to an admitted Email, nearest it first. */
export type MailSourceRef = MailMessageRef & {
  via?: readonly MailMessageRef[];
};

export type MailSourceAdmission = {
  mail: RetainedMail;
  /** Joins the roster in the writer's transaction. */
  supporting: boolean;
  /** `explicit`: the member selected this Email for import themselves. */
  attribution: MailAttribution | "explicit";
  /** The decision behind a judged attribution, reported by a refusal. */
  judgment?: MailAttributionJudgment;
};

/** Same-mailbox roster originals to compare against, the shared thread first. */
const ANCHOR_LIMIT = 3;

/**
 * Before the writer's transaction: judge every named source the Run needs a
 * decision for. Refuses a supporting original that is not confidently the
 * same purchase or the recipient's own transaction; paid judgment draws from
 * the household AI budget. A `via` path admits each Email on it in order, each
 * judged against the one before it and the first against the roster.
 */
export async function prepareMailSourceAdmissions(
  db: Database,
  runId: RunId,
  refs: readonly MailSourceRef[],
  actor: ActorContext,
  port?: DecisionPort,
): Promise<MailSourceAdmission[]> {
  if (!refs.length) return [];
  const database = getDb(db);
  const [owner] = await database
    .select({
      trigger: runTable.trigger,
      ledgerPartyId: runTable.ledgerPartyId,
    })
    .from(runTable)
    .where(and(eq(runTable.id, runId), notDeleted(runTable)));
  if (!owner?.ledgerPartyId) return [];
  const [party] = await database
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.id, owner.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        notDeleted(ledgerParty),
      ),
    );
  if (!party) return [];
  const roster = await readMailRunSources(database, runId);
  const retained = async (ref: MailMessageRef) =>
    (
      await readRetainedMail(db, {
        ledgerPartyIds: [party.id],
        mailboxId: ref.mailboxId,
        messageId: ref.messageId,
      })
    )[0];
  const mails: RetainedMail[] = [];
  /** The Email a path names before each of its members. */
  const previous = new Map<string, RetainedMail>();
  for (const ref of refs) {
    const mail = await retained(ref);
    // Missing originals fail the writer's own source checks.
    if (!mail) continue;
    const path: RetainedMail[] = [];
    for (const step of ref.via ?? []) {
      const bridge = await retained(step);
      if (!bridge || bridge.mailboxId !== mail.mailboxId)
        throw createAppError(
          "MAIL_SOURCE_ADMISSION_REFUSED",
          `The via Email ${step.mailboxId}/${step.messageId} is not a retained original of this member in mailbox ${mail.mailboxId}.`,
        );
      path.push(bridge);
    }
    path.push(mail);
    // A repeated Email would be judged against itself, skipping the roster link.
    if (new Set(path.map(({ id }) => id)).size !== path.length)
      throw createAppError(
        "MAIL_SOURCE_ADMISSION_REFUSED",
        `The via path for Email ${mail.messageId} names an Email more than once or names the Email itself; list each connecting Email once, nearest the admitted Email first.`,
      );
    path.forEach((step, index) => {
      const before = path[index - 1];
      if (before && !previous.has(step.id)) previous.set(step.id, before);
      if (!mails.some((known) => known.id === step.id)) mails.push(step);
    });
  }
  const member = (mail: RetainedMail) =>
    roster.some(
      (source) =>
        source.orderMailId === mail.id && source.owned && source.unchanged,
    );
  // Admission records the member's own selection; supporting sources never inherit it.
  const explicit = (mail: RetainedMail) =>
    owner.trigger === "foreground" && member(mail);
  const judged = mails.filter((mail) => !explicit(mail));
  const usage = judged.length
    ? {
        db,
        runId: await ensureRun(db, actor, aiCallRunInput(actor)),
        operation: "mail-source-admission",
      }
    : undefined;
  const attributions = usage
    ? await judgeMailAttributions(
        judged,
        await readMailOwnerEvidence(db, {
          ledgerPartyId: party.id,
          mailboxIds: judged.map((mail) => mail.mailboxId),
        }),
        usage,
        port,
      )
    : [];
  const admissions: MailSourceAdmission[] = [];
  for (const mail of mails) {
    const judgment = attributions[judged.indexOf(mail)];
    const attribution = judgment?.label ?? "explicit";
    if (member(mail) || !usage) {
      admissions.push({ mail, supporting: false, attribution, judgment });
      continue;
    }
    if (attribution !== "recipient")
      throw createAppError(
        "MAIL_SOURCE_ADMISSION_REFUSED",
        `Cubby cannot attribute that supporting Email's transaction to the recipient (${judgment ? describeMailAttribution(judgment) : attribution}); forwarding alone never proves ownership.`,
      );
    const before = previous.get(mail.id);
    if (before) {
      if (!(await judgeSameMailPurchase([before], mail, usage, port)))
        throw createAppError(
          "MAIL_SOURCE_ADMISSION_REFUSED",
          `Cubby could not establish that Email ${mail.messageId} is the same purchase as via Email ${before.messageId}; each Email on a via path must share an order, tracking or invoice identifier with the one before it.`,
        );
      admissions.push({ mail, supporting: true, attribution, judgment });
      continue;
    }
    const anchors = roster
      .filter(
        (source) =>
          source.owned &&
          source.unchanged &&
          source.email.mailboxId === mail.mailboxId,
      )
      .sort(
        (left, right) =>
          Number(right.email.threadId === mail.threadId) -
            Number(left.email.threadId === mail.threadId) ||
          Number(right.email.status === "researching") -
            Number(left.email.status === "researching") ||
          left.position - right.position,
      )
      .slice(0, ANCHOR_LIMIT);
    const anchorMails = (
      await readRetainedMail(db, {
        ledgerPartyIds: [party.id],
        orderMailIds: anchors.map((source) => source.orderMailId),
      })
    ).filter((anchor) =>
      anchors.some(
        (source) =>
          source.orderMailId === anchor.id &&
          source.checksum === anchor.rawChecksum,
      ),
    );
    if (!(await judgeSameMailPurchase(anchorMails, mail, usage, port)))
      throw createAppError(
        "MAIL_SOURCE_ADMISSION_REFUSED",
        `Cubby could not establish that the supporting Email ${mail.messageId} is the same purchase as an Email this Run admitted. When other retained Emails connect it to one (a shipping Email naming both a tracking and an order number), name them in via, nearest the admitted Email first.`,
      );
    admissions.push({ mail, supporting: true, attribution, judgment });
  }
  return admissions;
}

/**
 * Inside the writer's transaction. Supporting originals join the roster;
 * `requireAttribution` refuses an admitted Email whose transaction is not
 * the recipient's (a Purchase import), while a lifecycle link may proceed.
 */
export async function applyMailSourceAdmissions(
  db: Database,
  runId: RunId,
  admissions: readonly MailSourceAdmission[],
  options: { requireAttribution: boolean },
) {
  for (const admission of admissions) {
    if (admission.supporting)
      await admitSupportingMailSource(getDb(db), runId, admission.mail);
    else if (
      options.requireAttribution &&
      admission.attribution !== "explicit" &&
      admission.attribution !== "recipient"
    )
      throw createAppError(
        "MAIL_SOURCE_ADMISSION_REFUSED",
        `Automatic import needs the recipient's own transaction; this Email's attribution is ${admission.judgment ? describeMailAttribution(admission.judgment) : admission.attribution}. Resolve it unresolved so the member can select it explicitly.`,
      );
  }
}

/** Whether linking may record the recipient's relationship with the Vendor. */
export const mailAttributedToRecipient = (
  admission: MailSourceAdmission | undefined,
) =>
  !admission ||
  admission.attribution === "explicit" ||
  admission.attribution === "recipient";
