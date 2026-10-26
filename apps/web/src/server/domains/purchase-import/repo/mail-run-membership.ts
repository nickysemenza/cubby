import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import {
  MAIL_RUN_ROSTER_LIMIT,
  mailResearchRunInput,
  runInputsErased,
  runTargetOutcomeReceipt,
} from "@cubby/schemas/run-fields";
import { and, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { runOperation } from "~/server/db/generated/entity-table-definitions.gen";
import {
  repositoryQueries,
  type RepositoryQueryInput,
  type RepositoryQueryClient as DrizzleClient,
  type RepositoryQueryTransaction as DrizzleTransaction,
} from "~/server/db/repository-access.boundary";
import { email as emailTable, run } from "~/server/db/retained-tables";
import type { RetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { createAppError } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";

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
  db: RepositoryQueryInput,
  runId: RunId,
  mail: Pick<
    RetainedMail,
    "id" | "ledgerPartyId" | "mailboxId" | "messageId" | "rawChecksum"
  >,
) {
  const tx = repositoryQueries(db);
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
  // Targets fill at most 50 slots, so a full batch still admits the originals
  // its notices need; reaching the backstop means the coordinator is looping.
  if (roster.sources.length >= MAIL_RUN_ROSTER_LIMIT)
    throw createAppError(
      "MAIL_SOURCE_ADMISSION_REFUSED",
      `This Mail import Run already holds ${MAIL_RUN_ROSTER_LIMIT} Emails; resolve the current Email unresolved naming the supporting original.`,
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
    message.contentClearedAt
  )
    throw createAppError(
      "MAIL_SOURCE_ADMISSION_REFUSED",
      `A supporting original must be an unchanged, related Email with retained content; ${mail.messageId} is ${message ? `${message.deletedAt ? "deleted" : `classified ${message.classification ?? "unclassified"}`}${message.checksum === mail.rawChecksum ? "" : ", changed since read"}${message.contentClearedAt ? ", content cleared" : ""}` : "not a retained Email"}.`,
    );
  if (message.runId) {
    const [holder] = await tx
      .select({
        shortcode: run.shortcode,
        status: run.status,
        retiredAt: run.retiredAt,
        deletedAt: run.deletedAt,
      })
      .from(run)
      .where(eq(run.id, runEntityId.parse(message.runId)));
    // Name the holder and the way forward: a coordinator that only hears
    // "refused" escalated to the paid model over an Email it could link.
    if (holder && !holder.retiredAt && !holder.deletedAt)
      throw createAppError(
        "MAIL_SOURCE_HELD_BY_RUN",
        `Another Mail import Run holds ${message.shortcode} (${holder.shortcode}, ${holder.status}); it stays with that Run until that Run settles it or a member resumes or retries it. Settle the current Email without it: link a lifecycle notice to the Purchase it names, or resolve it unresolved naming ${message.shortcode}. Escalating does not change this.`,
      );
  }
  if (!["pending", "blocked"].includes(message.status))
    throw createAppError(
      "MAIL_SOURCE_ADMISSION_REFUSED",
      `A supporting original must be an Email no import has settled; ${message.shortcode} is ${message.status}.`,
    );
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
  await recordChange(db, { kind: "source", categories: ["email"] });
}

/**
 * An explicit member restart transfers the frozen roster's sources the Run
 * still holds, never discovery's pending queue. A source a failed Run already
 * returned to discovery (or another Run since admitted) stays where it is, and
 * the successor's roster drops it.
 */
export async function transferMailRunSources(
  tx: DrizzleTransaction,
  fromRunId: RunId,
  toRunId: RunId,
  selected?: readonly string[],
) {
  const sources = (await readMailRunSources(tx, fromRunId)).filter(
    (source) =>
      source.owned && (!selected || selected.includes(source.orderMailId)),
  );
  if (!sources.length)
    throw new Error(
      "This Run no longer holds any of those Emails; Mail discovery or another Run has them.",
    );
  if (sources.some((source) => !source.unchanged))
    throw new Error(
      "Mail restart evidence changed; reconcile the original Run.",
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
  const [successor] = await tx
    .select({ input: run.input })
    .from(run)
    .where(eq(run.id, toRunId));
  const roster = mailResearchRunInput.parse(successor?.input);
  await tx
    .update(run)
    .set({
      input: mailResearchRunInput.parse({
        ...roster,
        sources: roster.sources.filter((source) =>
          sources.some((held) => held.orderMailId === source.orderMailId),
        ),
      }),
      updatedAt: new Date(),
    })
    .where(eq(run.id, toRunId));
  await recordChange(tx, { kind: "source", categories: ["email"] });
}

/**
 * A Mail import Run that fails on its own, or whose coordinator stops for
 * review before claiming every Email, returns its still-researching Emails to
 * Mail discovery; nothing else would ever admit them again. Settled and
 * `blocked` Emails (the review's subject) stay. An Email an earlier Run already
 * left unsettled stays with this Run instead, so a message that keeps ending
 * its import unsettled does not spend a coordinator every discovery pass; a
 * member's retry still transfers it.
 */
export async function releaseUnsettledMailRunSources(
  tx: DrizzleTransaction,
  runId: RunId,
) {
  const held = (await readMailRunSources(tx, runId)).filter(
    (source) => source.owned && source.email.status === "researching",
  );
  if (!held.length) return [];
  const [current] = await tx
    .select({ startedAt: run.startedAt })
    .from(run)
    .where(eq(run.id, runId));
  if (!current) throw new Error("Mail import Run was not found");
  const earlierFailures = await tx
    .select({
      runId: runOperation.runId,
      kind: runOperation.kind,
      result: runOperation.result,
    })
    .from(run)
    .innerJoin(runOperation, eq(runOperation.runId, run.id))
    .where(
      and(
        eq(run.purpose, "mail_import"),
        or(
          and(
            eq(run.status, "failed"),
            inArray(run.failureCode, [...SELF_FAILURE_CODES]),
          ),
          eq(run.status, "needs_review"),
        ),
        ne(run.id, runId),
        lt(run.startedAt, current.startedAt),
        eq(runOperation.state, "completed"),
        inArray(runOperation.kind, ["target_outcome", "claim_next_work"]),
        or(
          ...held.map(
            (source) =>
              sql`${run.input}->'sources' @> ${JSON.stringify([{ orderMailId: source.orderMailId }])}::jsonb`,
          ),
        ),
      ),
    )
    .orderBy(runOperation.startedAt, runOperation.id);
  // A roster is admission, not evidence that its coordinator reached an Email.
  // A later settled outcome supersedes that Run's claim or unresolved outcome.
  const attempts = new Map<
    string,
    { orderMailId: string; unsettled: boolean }
  >();
  for (const row of earlierFailures) {
    if (row.kind === "target_outcome") {
      const receipt = runTargetOutcomeReceipt.safeParse(row.result);
      if (!receipt.success) continue;
      for (const source of held)
        if (
          receipt.data.target.workKey === source.orderMailId ||
          (receipt.data.target.entityKind === "email" &&
            receipt.data.target.entityId === source.email.id)
        )
          attempts.set(`${row.runId}:${source.orderMailId}`, {
            orderMailId: source.orderMailId,
            unsettled: receipt.data.target.state !== "completed",
          });
    } else {
      const claim = claimedMail.safeParse(row.result);
      if (!claim.success) continue;
      for (const source of held)
        if (
          source.email.mailboxId === claim.data.email.mailboxId &&
          source.email.messageId === claim.data.email.messageId
        )
          attempts.set(`${row.runId}:${source.orderMailId}`, {
            orderMailId: source.orderMailId,
            unsettled: true,
          });
    }
  }
  const failedBefore = new Set(
    [...attempts.values()]
      .filter((attempt) => attempt.unsettled)
      .map((attempt) => attempt.orderMailId),
  );
  const released = held.filter(
    (source) => !failedBefore.has(source.orderMailId),
  );
  if (!released.length) return [];
  // The admission replay key names this Run's source set; readmitting the same
  // released Emails would otherwise replay this ended Run instead of starting one.
  await tx.update(run).set({ clientKey: null }).where(eq(run.id, runId));
  return tx
    .update(emailTable)
    .set({ runId: null, status: "pending", updatedAt: new Date() })
    .where(
      and(
        eq(emailTable.runId, runId),
        eq(emailTable.status, "researching"),
        inArray(
          emailTable.id,
          released.map((source) => source.email.id),
        ),
      ),
    )
    .returning({ id: emailTable.id });
}

/** Failures the Run reached on its own; a member's cancel keeps its Emails. */
const SELF_FAILURE_CODES = ["agent_failed", "agent_aborted"] as const;

const claimedMail = z.object({
  kind: z.literal("email"),
  email: z.object({ mailboxId: z.string(), messageId: z.string() }),
});
