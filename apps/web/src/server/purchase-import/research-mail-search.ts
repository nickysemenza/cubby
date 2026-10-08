import type { RunId } from "@cubby/schemas/identifiers";
import type { ResearchMailSearchInput } from "@cubby/schemas/research-tools";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import { mailboxMessage, orderMail, run } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertOperation, readOperation } from "~/server/repo/run-operation";
import { executeLeasedOperation } from "~/server/runs/operation";
import { runFailureText } from "~/server/workflow-runs/lifecycle";

import { ingestGmailMessages } from "./gmail/ingest";
import { gmailProviderForUser } from "./gmail/provider";
import { GMAIL_PAGE_SIZE } from "./gmail/sync";
import { GmailAuthorizationError } from "./gmail/tokens";
import { GmailApiError } from "./gmail/types";
import {
  assertResearchRunNotRetired,
  exposeResearchSources,
} from "./research-retention";
import { startMailResearch } from "./research-run";

const mailboxScope = z.strictObject({
  mailboxId: z.string().min(1),
  accountRef: z.string().min(1),
});
const mailContinuation = mailboxScope.extend({
  workRef: z.uuid(),
  query: z.string(),
  pageToken: z.string().min(1),
});
type MailboxScope = z.infer<typeof mailboxScope>;
type SearchContext = {
  runId: RunId;
  callId: string;
  scope: Pick<
    typeof run.$inferSelect,
    "input" | "actorUserId" | "ledgerPartyId"
  >;
  input: ResearchMailSearchInput;
};
const sameMailbox = (left: MailboxScope, right: MailboxScope) =>
  left.mailboxId === right.mailboxId && left.accountRef === right.accountRef;

async function savePrivatePosition(
  db: Database,
  runId: RunId,
  operationId: string,
  kind: string,
  position: MailboxScope | z.infer<typeof mailContinuation>,
) {
  await insertOperation(
    getDb(db),
    {
      runId,
      operationId,
      kind,
      state: "completed",
      result: position,
      inputFingerprint: await sha256Hex(JSON.stringify(position)),
    },
    { ifAbsent: true },
  );
}

async function readMailboxChoice(db: Database, context: SearchContext) {
  if (!context.input.mailboxRef) return undefined;
  const choice = await readOperation(getDb(db), {
    runId: context.runId,
    operationId: context.input.mailboxRef,
  });
  if (
    !choice ||
    choice.kind !== "research_mail_choice" ||
    choice.state !== "completed"
  )
    throw new Error("Mailbox choice was not issued for this Run.");
  return mailboxScope.parse(choice.result);
}

async function issueMailboxChoices(
  db: Database,
  runId: RunId,
  available: MailboxScope[],
) {
  const choices = [];
  for (const mailbox of available) {
    const mailboxRef = crypto.randomUUID();
    await savePrivatePosition(
      db,
      runId,
      mailboxRef,
      "research_mail_choice",
      mailbox,
    );
    choices.push({ mailboxRef });
  }
  return choices;
}

async function readContinuation(db: Database, context: SearchContext) {
  const { runId, input } = context;
  if (!input.continuationRef) return undefined;
  const saved = await readOperation(getDb(db), {
    runId,
    operationId: input.continuationRef,
  });
  if (
    !saved ||
    saved.kind !== "research_mail_continuation" ||
    saved.state !== "completed"
  )
    throw new Error("Mail continuation does not belong to this Run.");
  const position = mailContinuation.parse(saved.result);
  if (position.workRef !== input.workRef || position.query !== input.query)
    throw new Error(
      "Mail continuation does not belong to this task and query.",
    );
  return position;
}

async function readSearchMailbox(
  db: Database,
  key: Parameters<typeof readOperation>[1],
  requested: MailboxScope | undefined,
) {
  const saved = await readOperation(getDb(db), key);
  if (!saved) return undefined;
  if (
    saved.kind !== "research_mail_search_scope" ||
    saved.state !== "completed"
  )
    throw new Error("Research mail search scope is unavailable.");
  const selected = mailboxScope.parse(saved.result);
  if (requested && !sameMailbox(requested, selected))
    throw new Error("Research mail search selection changed on replay.");
  return selected;
}

async function selectMailbox(db: Database, context: SearchContext) {
  const { runId, scope } = context;
  const database = getDb(db);
  const position = await readContinuation(db, context);
  const chosen = await readMailboxChoice(db, context);
  if (position && chosen && !sameMailbox(position, chosen))
    throw new Error("Mail continuation does not belong to this mailbox.");
  const requestedMailbox = position
    ? { mailboxId: position.mailboxId, accountRef: position.accountRef }
    : chosen;
  // A failed search retries its own selection; another investigation may choose
  // another connected mailbox without changing any existing continuation.
  const scopeKey = {
    runId,
    operationId: `__research_mail_search_scope:${context.callId}`,
  };
  const saved = await readSearchMailbox(db, scopeKey, requestedMailbox);
  const connected = await database
    .select({ accountRef: account.id, mailboxId: account.accountId })
    .from(account)
    .where(
      and(
        eq(account.userId, scope.actorUserId!),
        eq(account.providerId, "google"),
      ),
    )
    .orderBy(asc(account.id));
  let selected = saved ?? requestedMailbox;
  if (!selected) {
    if (!connected.length)
      throw new Error("Connect Google before searching Gmail.");
    if (connected.length === 1) selected = connected[0];
    else return { choices: await issueMailboxChoices(db, runId, connected) };
  }
  const candidate = selected;
  if (!candidate || !connected.some((item) => sameMailbox(item, candidate)))
    throw new Error(
      "The selected Google mailbox is no longer connected to this member.",
    );
  if (!saved) {
    await savePrivatePosition(
      db,
      runId,
      scopeKey.operationId,
      "research_mail_search_scope",
      candidate,
    );
    const committed = await readOperation(database, scopeKey);
    const bound = mailboxScope.parse(committed?.result);
    if (!sameMailbox(bound, candidate))
      throw new Error(
        "Another attempt already selected this search's mailbox.",
      );
    return { selected: bound, pageToken: position?.pageToken };
  }
  return { selected: candidate, pageToken: position?.pageToken };
}

/** Scoped reads share acquisition and source ownership, never the broad cursor. */
async function searchConnectedResearchMail(
  db: Database,
  context: SearchContext,
) {
  const { runId, scope, input } = context;
  const selectedScope = await selectMailbox(db, context);
  if (!selectedScope.selected)
    return {
      status: "mailbox_required",
      sources: [],
      moreAvailable: false,
      continuationRef: null,
      mailboxChoices: selectedScope.choices,
    };
  const { selected, pageToken } = selectedScope;
  const provider = await gmailProviderForUser(
    db,
    scope.actorUserId!,
    selected.mailboxId,
  );
  const request: Parameters<typeof provider.listMessages>[0] = {
    query: `(${input.query}) -in:spam -in:trash`,
    maxResults: GMAIL_PAGE_SIZE,
  };
  if (pageToken) request.pageToken = pageToken;
  // A failed admission replays these bounded IDs even if Gmail's ordering changes.
  const page = z
    .strictObject({
      messageIds: z.array(z.string().min(1)).max(GMAIL_PAGE_SIZE),
      nextPageToken: z.string().min(1).nullable(),
    })
    .parse(
      await executeLeasedOperation(
        db,
        {
          runId,
          operationId: `__research_mail_page:${context.callId}`,
          kind: "research_mail_page",
          payload: {
            workRef: input.workRef,
            query: input.query,
            mailbox: selected,
            pageToken: pageToken ?? null,
          },
        },
        async () => {
          const listed = await provider.listMessages(request);
          const messageIds = [
            ...new Set(listed.messages?.map((message) => message.id) ?? []),
          ];
          if (messageIds.length > GMAIL_PAGE_SIZE)
            throw new Error("Gmail returned an oversized research page.");
          return { messageIds, nextPageToken: listed.nextPageToken ?? null };
        },
      ),
    );
  const providerMessageIds = page.messageIds;
  const ingested = await ingestGmailMessages(db, provider, {
    ledgerPartyId: scope.ledgerPartyId!,
    mailboxId: selected.mailboxId,
    messageIds: providerMessageIds,
    runId,
  });
  const retained = providerMessageIds.length
    ? await getDb(db)
        .select({
          messageRef: orderMail.id,
          checksum: orderMail.rawChecksum,
          sender: orderMail.sender,
          subject: orderMail.subject,
          receivedAt: orderMail.receivedAt,
        })
        .from(orderMail)
        .innerJoin(
          mailboxMessage,
          and(
            eq(mailboxMessage.orderMailId, orderMail.id),
            eq(mailboxMessage.ledgerPartyId, orderMail.ledgerPartyId),
            eq(mailboxMessage.mailboxId, orderMail.mailboxId),
            eq(mailboxMessage.messageId, orderMail.messageId),
            eq(mailboxMessage.checksum, orderMail.rawChecksum),
            inArray(mailboxMessage.classification, ["related", "uncertain"]),
            inArray(mailboxMessage.status, [
              "pending",
              "researching",
              "completed",
            ]),
          ),
        )
        .where(
          and(
            eq(orderMail.ledgerPartyId, scope.ledgerPartyId!),
            eq(orderMail.mailboxId, selected.mailboxId),
            inArray(orderMail.messageId, providerMessageIds),
          ),
        )
    : [];
  await exposeResearchSources(db, {
    runId,
    sources: retained.map((source) => ({
      orderMailId: source.messageRef,
      checksum: source.checksum,
    })),
  });
  const children = await startMailResearch(db, {
    ledgerPartyId: scope.ledgerPartyId!,
    userId: scope.actorUserId!,
    mailboxId: selected.mailboxId,
    parentRunId: runId,
    parentWorkRef: input.workRef,
    messageIds: retained.map((source) => source.messageRef),
    expectedChecksums: retained.map((source) => ({
      orderMailId: source.messageRef,
      checksum: source.checksum,
    })),
  });
  if (children.some((child) => child.status === "dispatch_failed"))
    throw new Error("Mail research dispatch failed; replay the retained page.");
  let continuationRef: string | null = null;
  if (page.nextPageToken) {
    continuationRef = crypto.randomUUID();
    await savePrivatePosition(
      db,
      runId,
      continuationRef,
      "research_mail_continuation",
      {
        ...selected,
        workRef: input.workRef,
        query: input.query,
        pageToken: page.nextPageToken,
      },
    );
  }
  return {
    sources: retained.map(({ checksum: _checksum, ...source }) => ({
      ...source,
      receivedAt: source.receivedAt?.toISOString() ?? null,
    })),
    moreAvailable: Boolean(page.nextPageToken),
    continuationRef,
    blocked: ingested.blocked.length,
  };
}

/** Optional Gmail access never fences the Run's other research capabilities. */
export async function searchResearchMail(db: Database, context: SearchContext) {
  try {
    await assertResearchRunNotRetired(db, context.runId);
    return await searchConnectedResearchMail(db, context);
  } catch (error) {
    const auth =
      error instanceof GmailAuthorizationError ||
      (error instanceof GmailApiError &&
        (error.status === 401 ||
          (error.status === 403 &&
            error.reason === "insufficientPermissions")));
    if (!auth) throw error;
    return {
      status: "capability_unavailable",
      capability: "gmail",
      code: "gmail_reconnect_required",
      detail: runFailureText(error),
      retryAfterReconnect: true,
    };
  }
}
