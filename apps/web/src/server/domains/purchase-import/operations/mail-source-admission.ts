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

import { readMailOwnerEvidence } from "../repo/mail-owner";
import {
  describeMailAttribution,
  judgeMailAttributions,
  judgeSameMailPurchase,
  type MailAttribution,
  type MailAttributionJudgment,
} from "../service/mail-source-judgment";

export type MailSourceRef = { mailboxId: string; messageId: string };

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
 * the household AI budget.
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
  const mails: RetainedMail[] = [];
  for (const ref of refs) {
    const [mail] = await readRetainedMail(db, {
      ledgerPartyIds: [party.id],
      mailboxId: ref.mailboxId,
      messageId: ref.messageId,
    });
    // Missing originals fail the writer's own source checks.
    if (mail && !mails.some((known) => known.id === mail.id)) mails.push(mail);
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
      throw new Error(
        `Cubby cannot attribute that supporting Email's transaction to the recipient (${judgment ? describeMailAttribution(judgment) : attribution}); forwarding alone never proves ownership.`,
      );
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
      throw new Error(
        "Cubby could not establish that the supporting Email is the same purchase as an Email this Run admitted.",
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
      throw new Error(
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
