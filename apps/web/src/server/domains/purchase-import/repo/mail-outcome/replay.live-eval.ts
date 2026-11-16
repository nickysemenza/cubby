import { agentConversationSchema } from "@cubby/schemas/agent-conversation";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  importRunAgentManifest,
  EXTRACT_ORDER_TOOL,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import { mailAttributionHeaders } from "@cubby/schemas/mailbox-research";
import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { mailImportOutcome } from "@cubby/schemas/suggestion";
import {
  CF_ACCOUNT_ID,
  testAiGatewayEnvironment,
} from "@cubby/shared/ai/gateway-metadata";
import { supportedChatModelSchema } from "@cubby/shared/ai/models";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, count, desc, eq, inArray, or } from "drizzle-orm";
import { liveReplayBudget } from "tooling/ai/live-replay-budget";
import { localSecret } from "tooling/local-secret";
import {
  call,
  from,
  mcp,
  mcpRead,
  type ScriptStep,
} from "tooling/purchase-agent-script";
import { withTestDb } from "tooling/test-setup";
import { withWorkerdRuntime } from "tooling/workerd-runtime";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { insertFieldsFixture } from "~/server/ai/fields/fields.fixtures";
import { user } from "~/server/db/auth.schema";
import { getDb, notDeleted } from "~/server/db/helpers";
import { kernelPass } from "~/server/db/kernel-schema";
import {
  aiUsage,
  email as emailTable,
  expense,
  product as productTable,
  runOperation,
  run as runTable,
} from "~/server/db/schema";
import {
  storedMailOutcome,
  mailOutcomeOfEmailSql,
} from "~/server/domains/purchase-import/repo/mail-outcome/outcome";
import { captureBackgroundQueue } from "~/server/testing/background-queue";

import {
  memberImportWorld,
  retainedMailFixture,
} from "../../operations/order-import.fixtures";
import {
  observeMailReplayAttempt,
  mailReplayDisagreement,
  type MailReplayCaseReport,
} from "../../service/mail-replay-report";
import { startMailImport } from "../mail-import-run";
import {
  authorizePurchaseAgent,
  enableSyntheticMailImport,
  startScenarioHarness,
  waitFor,
} from "../purchase-agent-workerd.fixtures";

/** Source originals arrive over an ephemeral loopback socket, never files or argv. */
const replayMail = z.object({
  subject: z.string().nullable(),
  sender: z.string().nullable(),
  receivedAt: z.iso.datetime(),
  bodyText: z.string(),
  bodyHtml: z.string().nullable().default(null),
  /**
   * The original's addressing and forwarding headers. Attribution reads
   * only `mailAttributionHeaders`' subset, so any other header is dropped.
   */
  headers: z
    .record(z.string(), z.string())
    .optional()
    .transform((headers) =>
      headers
        ? mailAttributionHeaders(
            Object.fromEntries(
              Object.entries(headers).map(([name, value]) => [
                name.toLowerCase(),
                value,
              ]),
            ),
          )
        : undefined,
    ),
  /**
   * The mailbox owner production judged against: the member's LedgerParty
   * name and sign-in address. Absent, the synthetic member owns the
   * mailbox and own-mail attribution cannot match a real recipient.
   */
  owner: z.object({ name: z.string().min(1), address: z.email() }).optional(),
  baseline: mailImportOutcome,
  /** Trusted synthetic benchmark configuration, never derived from Email prose. */
  readFanout: z.array(z.string().min(1)).length(8).optional(),
  /** Existing catalog identities whose reuse is verified after settlement. */
  catalogProducts: z.array(z.string().min(1)).min(1).max(50).optional(),
});
const replayCases = z
  .array(
    replayMail.extend({
      /** Later sources share the same durable Run and mailbox. */
      followingEmails: z
        .array(
          replayMail.omit({
            readFanout: true,
            catalogProducts: true,
            owner: true,
          }),
        )
        .max(4)
        .optional(),
    }),
  )
  .min(1)
  .max(100);
const scripted = process.env.MAIL_REPLAY_SCRIPTED === "1";
const readCode = process.env.MAIL_REPLAY_READ_CODE === "1";
const bulkReads = process.env.MAIL_REPLAY_BULK_READS === "1";
// Shared two-read workload; Code Mode also verifies ordinary recovery after an error.
const scriptedReads: ScriptStep[] = readCode
  ? [
      call("load-code", "tool_search", { query: "codemode", limit: 1 }),
      call("read-code-failure", "codemode", {
        code: 'throw new Error("Synthetic script failure")',
      }),
      { check: "read-code-failure", includes: "Synthetic script failure" },
      call("load-reads", "tool_search", { query: "entity_read", limit: 1 }),
      mcpRead("read-code-recovery", "entity_read", {
        action: "resolve",
        entity: "product",
        names: ["Synthetic ceramic mug"],
      }),
      call("read-code", "codemode", {
        code: `if (typeof fetch !== "undefined" || typeof process !== "undefined" || typeof require !== "undefined" || "mcp__cubby__purchase_import" in tools || "claim_next_import_work" in tools || typeof models !== "undefined") throw new Error("Unexpected sandbox authority"); const declaration = await describeTool("mcp__cubby__entity_read"); if (!declaration.includes("action")) throw new Error("Read declaration missing"); const matches = await Promise.all(["Synthetic ceramic mug", "Synthetic tea towel"].map(name => tools.mcp__cubby__entity_read({action:"resolve",entity:"product",names:[name]}))); if (!matches.every(value => typeof value === "object" && Array.isArray(value.results))) throw new Error("Expected structured read objects"); text({kind:"read-code-success",successfulReads:matches.length,matches});`,
      }),
      { check: "read-code", includes: "readCalls" },
      { check: "read-code", includes: "read-code-success" },
      { check: "read-code", includes: '"successfulReads":2' },
    ]
  : [
      call("load-reads", "tool_search", { query: "entity_read", limit: 1 }),
      mcpRead("read-mug", "entity_read", {
        action: "resolve",
        entity: "product",
        names: ["Synthetic ceramic mug"],
      }),
      mcpRead("read-towel", "entity_read", {
        action: "resolve",
        entity: "product",
        names: ["Synthetic tea towel"],
      }),
    ];
const evaluationBudget = scripted ? null : await liveReplayBudget();
const inputUrl = process.env.MAIL_REPLAY_INPUT_URL;
if (process.env.CI && inputUrl)
  throw new Error("Private replay input is session-only");
if (scripted && inputUrl)
  throw new Error("Scripted replay accepts synthetic fixtures only");
const syntheticInquiry = {
  subject: "Synthetic order inquiry",
  sender: "orders@shop.example",
  receivedAt: "2026-09-20T18:00:00Z",
  bodyText: "Synthetic inquiry: no order id, itemization or amount.",
  baseline: { kind: "unresolved", reason: "Synthetic missing itemization" },
};
// Own mail: the To header names the seeded owner, so attribution defaults to
// the recipient and an itemized order must import.
const syntheticOwnOrder = {
  subject: "Your Synthetic Shop order SYN-1001 is confirmed",
  sender: "Synthetic Shop <orders@shop.example>",
  receivedAt: "2026-09-20T18:00:00Z",
  headers: {
    From: "Synthetic Shop <orders@shop.example>",
    To: "Sam Synthetic <sam.synthetic@example.com>",
  },
  owner: { name: "Sam Synthetic", address: "sam.synthetic@example.com" },
  bodyText: [
    "Hi Sam, thanks for your order!",
    "Order SYN-1001, placed September 20, 2026.",
    "1 x Synthetic ceramic mug: $12.00",
    "2 x Synthetic tea towel at $4.50: $9.00",
    "Subtotal: $21.00",
    "Sales tax: $1.89",
    "Order total: $22.89, charged to Visa ending 0000.",
  ].join("\n"),
  baseline: {
    kind: "imported",
    total: 22.89,
    lines: [
      { name: "Synthetic ceramic mug", cost: 12 },
      { name: "Synthetic tea towel", cost: 9 },
      { name: "Sales tax", cost: 1.89 },
    ],
  },
};
const syntheticAttemptLimit = {
  ...syntheticInquiry,
  subject: "Synthetic malformed extraction limit",
  baseline: {
    ...syntheticInquiry.baseline,
    category: "attempt_limit",
  },
};
const synthetic = [
  {
    ...syntheticInquiry,
    followingEmails: [
      {
        ...syntheticInquiry,
        subject: "Synthetic shipping question",
        bodyText:
          "Synthetic shipping inquiry without an order identifier, amount or itemized evidence.",
      },
      {
        ...syntheticInquiry,
        subject: "Synthetic invoice question",
        bodyText:
          "Synthetic invoice inquiry without a receipt, order identifier or priced items.",
      },
    ],
  },
  syntheticOwnOrder,
  ...(scripted ? [syntheticAttemptLimit] : []),
];
async function readInput() {
  if (!inputUrl) return synthetic;
  const url = new URL(inputUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
    throw new Error("Replay input must use the local stdin transport");
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Replay input transport failed (${response.status})`);
  return response.json();
}
const parsed = replayCases.safeParse(await readInput());
if (!parsed.success)
  throw new Error(
    "Invalid replay input; expected retained text and a frozen outcome for every case",
  );
const cases = parsed.data;
// Without overrides a replay runs production's models.
const primary = supportedChatModelSchema.parse(
  process.env.MAIL_REPLAY_MODEL ?? importRunAgentManifest.mail_import.model,
);
const escalation = supportedChatModelSchema.parse(
  process.env.MAIL_REPLAY_ESCALATION_MODEL ??
    importRunAgentManifest.mail_import.escalationModel,
);
const reports: (MailReplayCaseReport & {
  /** Runtime start, and admission to settlement, in seconds. */
  seconds?: { startup: number; settle: number };
})[] = [];
// One case's whole budget: workerd start (minutes on a loaded host), the
// coordinator's settlement and observation. Settlement waits only until the
// reserve, so a slow case still records its report before Vitest abandons it.
const CASE_BUDGET_MS = (scripted ? 3 : 15) * 60_000;
const REPORT_RESERVE_MS = 60_000;
const DIAGNOSTIC_LOGS = 8;
const DIAGNOSTIC_CHARS = 800;
/** A case that never reached observation: its runtime or admission failed. */
const unavailable = (caseNumber: number, failure: string) => ({
  case: caseNumber,
  fields: ["unavailable"],
  status: "infrastructure_error",
  actualModels: [],
  failure,
  failedAttempts: [],
  diagnostics: [],
  outcome: null,
  usd: {},
});

// Failure modes: replay reaches production data or Gmail; two cases share
// ledger writes; comparison publishes grades; a missing outcome counts as parity.
describe("isolated Mail coordinator replay", () => {
  const ctx = withTestDb(); // A fresh throwaway database for each case.
  afterAll(async () => {
    await evaluationBudget?.close();
    for (const [index] of cases.entries()) {
      if (!reports.some((report) => report.case === index + 1))
        reports.push(
          unavailable(
            index + 1,
            `Case exceeded its ${CASE_BUDGET_MS / 60_000}-minute budget before observation`,
          ),
        );
    }
    reports.sort((a, b) => a.case - b.case);
    const disagreements = reports.filter((report) => report.fields.length);
    console.log(
      JSON.stringify({
        kind: "mail-import-replay",
        reportVersion: 2,
        costScope: "run_features_and_case_receipts",
        synthetic: !inputUrl,
        scripted,
        readMode: readCode ? "code" : "ordinary",
        bulkReads,
        primary,
        escalation,
        cases: reports.length,
        emails: cases.reduce(
          (total, sample) => total + 1 + (sample.followingEmails?.length ?? 0),
          0,
        ),
        parity: reports.length - disagreements.length,
        actualModels: [
          ...new Set(reports.flatMap((report) => report.actualModels)),
        ],
        requestedPrimaryObservedCases: reports.filter((report) =>
          report.actualModels.includes(primary),
        ).length,
        disagreements,
        measurements: reports.map((report) => ({
          case: report.case,
          sourceCount:
            1 + (cases[report.case - 1]?.followingEmails?.length ?? 0),
          seconds: report.seconds ?? null,
          diagnostics: report.diagnostics,
          usage: report.usage ?? null,
          // A known subtotal is not a complete cost when usage is unpriced.
          unpricedCalls:
            report.usage?.filter(
              (row) =>
                row.standardCost === null &&
                // Match AI accounting's failed-without-usage distinction.
                !(
                  row.status === "failed" &&
                  row.inputTokens === null &&
                  row.outputTokens === null &&
                  row.cacheReadTokens === null &&
                  row.cacheWriteTokens === null
                ),
            ).length ?? null,
        })),
        /** Known standard cost of every Run-scoped feature, not just coordination. */
        knownStandardUsd: reports.map((report) => ({
          case: report.case,
          total: Object.values(report.usd).reduce((sum, usd) => sum + usd, 0),
          byModel: report.usd,
        })),
        limitations: [
          "Mechanical parity is not a human quality grade; review disagreements through authenticated MCP.",
          "Only supplied originals are copied. Existing Purchases, catalog, attachments and other Emails are absent.",
          "Gmail and object storage are unreachable; unavailable evidence must remain unresolved.",
          "Actual models include funding recovery; a substituted run does not establish the requested model's quality.",
        ],
      }),
    );
  });
  for (const [index, sample] of cases.entries())
    it(
      `replays case ${index + 1}`,
      async () => {
        const caseStartedAt = Date.now();
        const settleBy = caseStartedAt + CASE_BUDGET_MS - REPORT_RESERVE_MS;
        let admittedAt = caseStartedAt;
        let diagnose = async (): Promise<string[]> => [];
        let fanoutVerified = false;
        let catalogVerified = false;
        let followingVerified = false;
        let followingDisagreements: string[] = [];
        const catalogProductIds: Array<typeof productTable.$inferSelect.id> =
          [];
        let initialProductCount = 0;
        const queueCapture = captureBackgroundQueue();
        try {
          const { party } = await memberImportWorld(ctx.db, ctx.actor, {
            memberName: sample.owner?.name,
          });
          for (const name of sample.catalogProducts ?? []) {
            const product = await insertFieldsFixture(ctx.db, "product", {
              name,
            });
            catalogProductIds.push(product.id);
          }
          if (catalogProductIds.length) {
            const [row] = await getDb(ctx.db)
              .select({ count: count() })
              .from(productTable)
              .where(notDeleted(productTable));
            initialProductCount = row!.count;
          }
          // Owner evidence is the member's sign-in address (the Gmail profile
          // is unreachable), so it carries the original recipient's address.
          if (sample.owner)
            await getDb(ctx.db)
              .update(user)
              .set({ email: sample.owner.address })
              .where(eq(user.id, ctx.actor.userId));
          const mailboxId = "synthetic-replay-mailbox";
          const sources = [sample, ...(sample.followingEmails ?? [])];
          // The frozen roster orders by id. Fresh sorted UUIDs make the
          // dependent-read source precede the ordinary follow-up sources.
          const ids = sources.map(() => crypto.randomUUID()).sort();
          const mails = await Promise.all(
            sources.map(async (source, sourceIndex) =>
              retainedMailFixture(ctx.db, {
                id: ids[sourceIndex]!,
                ledgerPartyId: party.id,
                mailboxId,
                messageId: `synthetic-replay-${index}-${sourceIndex}`,
                subject: source.subject,
                sender: source.sender,
                receivedAt: new Date(source.receivedAt),
                checksum: await sha256Hex(
                  JSON.stringify({
                    bodyText: source.bodyText,
                    bodyHtml: source.bodyHtml,
                    headers: source.headers,
                  }),
                ),
                content: {
                  snippet: null,
                  bodyText: source.bodyText,
                  bodyHtml: source.bodyHtml,
                  ...(source.headers && { headers: source.headers }),
                },
                classificationVersion: "isolated-replay-v1",
              }),
            ),
          );
          const identities = await getDb(ctx.db)
            .select({ id: emailTable.id, originalId: emailTable.orderMailId })
            .from(emailTable)
            .where(
              inArray(
                emailTable.orderMailId,
                mails.map((source) => source.id),
              ),
            );
          const emailIds = new Map(
            identities.map((source) => [source.originalId, source.id]),
          );
          await enableSyntheticMailImport(ctx, mailboxId);
          await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
          const [started] = await startMailImport(ctx.db, {
            ledgerPartyId: party.id,
            userId: ctx.actor.userId,
            messageIds: mails.map((source) => source.id),
          });
          const [dispatch] = await getDb(ctx.db)
            .select()
            .from(kernelPass)
            .where(eq(kernelPass.runId, started!.runId));
          const event = dispatch
            ? z
                .object({
                  events: z
                    .tuple([purchaseAgentEvent])
                    .rest(purchaseAgentEvent),
                })
                .parse(dispatch.cursor).events[0]
            : null;
          if (!started || !event)
            throw new Error(
              "Replay admission did not produce a coordinator event",
            );
          const runId = parseEntityId("run", started.runId);
          let status = "running";
          const waitForSettlement = async () => {
            admittedAt = Date.now();
            await waitFor(
              async () => {
                evaluationBudget?.assertActive();
                const [row] = await getDb(ctx.db)
                  .select({ status: runTable.status })
                  .from(runTable)
                  .where(eq(runTable.id, runId));
                status = row?.status ?? "missing";
                return status !== "running";
              },
              `Replay coordinator did not settle within the case budget (${Math.round((settleBy - caseStartedAt) / 1000)}s including runtime start)`,
              Math.max(0, settleBy - Date.now()),
            );
          };
          const observe = (run: () => Promise<void>) =>
            observeMailReplayAttempt({
              caseIndex: index + 1,
              baseline: sample.baseline,
              run,
              read: async () => {
                const outcomes = await Promise.all(
                  mails.map(async (source) => {
                    const emailId = emailIds.get(source.id);
                    if (!emailId)
                      throw new Error("Replay Email identity is missing");
                    const [outcome] = await getDb(ctx.db)
                      .select({ result: runOperation.result })
                      .from(runOperation)
                      .where(
                        and(
                          eq(runOperation.runId, runId),
                          mailOutcomeOfEmailSql(emailId),
                        ),
                      )
                      .orderBy(desc(runOperation.completedAt))
                      .limit(1);
                    return outcome
                      ? (storedMailOutcome.safeParse(outcome.result).data
                          ?.mailOutcome.judgment ?? null)
                      : null;
                  }),
                );
                const following = sources
                  .slice(1)
                  .map((source, sourceIndex) => ({
                    source: sourceIndex + 2,
                    fields: mailReplayDisagreement(
                      source.baseline,
                      outcomes[sourceIndex + 1] ?? null,
                    ),
                  }));
                followingVerified = following.every((source) =>
                  source.fields.every(
                    (field) => field === "reason" || field === "category",
                  ),
                );
                followingDisagreements = following.flatMap(
                  (source) => source.fields,
                );
                const usage = await getDb(ctx.db)
                  .select({
                    feature: aiUsage.feature,
                    model: aiUsage.model,
                    status: aiUsage.status,
                    transport: aiUsage.transport,
                    failure: aiUsage.failure,
                    standardCost: aiUsage.standardCost,
                    chargedCost: aiUsage.chargedCost,
                    gatewayLogId: aiUsage.gatewayLogId,
                    inputTokens: aiUsage.inputTokens,
                    outputTokens: aiUsage.outputTokens,
                    cacheReadTokens: aiUsage.cacheReadTokens,
                    cacheWriteTokens: aiUsage.cacheWriteTokens,
                    durationMs: aiUsage.durationMs,
                  })
                  .from(aiUsage)
                  .where(
                    or(
                      eq(aiUsage.runId, runId),
                      inArray(
                        aiUsage.gatewayLogId,
                        evaluationBudget?.receiptIds() ?? [],
                      ),
                    ),
                  )
                  .orderBy(aiUsage.createdAt);
                const [failed] = await getDb(ctx.db)
                  .select({
                    code: runTable.failureCode,
                    detail: runTable.dispatchError,
                  })
                  .from(runTable)
                  .where(eq(runTable.id, runId));
                const catalogDiagnostics: string[] = [];
                if (catalogProductIds.length) {
                  const lines = await getDb(ctx.db)
                    .select({ productId: expense.productId })
                    .from(expense)
                    .where(
                      and(
                        notDeleted(expense),
                        eq(expense.lineKind, "principal"),
                      ),
                    );
                  const [products] = await getDb(ctx.db)
                    .select({ count: count() })
                    .from(productTable)
                    .where(notDeleted(productTable));
                  const existingLinks = catalogProductIds.filter(
                    (id) =>
                      lines.filter((line) => line.productId === id).length ===
                      1,
                  ).length;
                  const newProducts = products!.count - initialProductCount;
                  catalogVerified =
                    lines.length === catalogProductIds.length &&
                    existingLinks === catalogProductIds.length &&
                    newProducts === 0;
                  catalogDiagnostics.push(
                    `catalog reuse: ${JSON.stringify({ verified: catalogVerified, expectedProducts: catalogProductIds.length, principalLines: lines.length, existingLinks, newProducts })}`,
                  );
                }
                return {
                  status,
                  failure:
                    failed?.code || failed?.detail
                      ? [failed.code, failed.detail].filter(Boolean).join(": ")
                      : null,
                  outcome: outcomes[0] ?? null,
                  actualModels: usage
                    .filter(
                      (row) =>
                        row.status === "succeeded" &&
                        row.feature === "purchase_import_agent",
                    )
                    .map((row) => row.model),
                  failedAttempts: usage
                    .filter((row) => row.status !== "succeeded")
                    .map((row) =>
                      `${row.model} (${row.transport}): ${row.failure ?? row.status}`.slice(
                        0,
                        DIAGNOSTIC_CHARS,
                      ),
                    ),
                  diagnostics: [
                    ...(await diagnose().catch((error: unknown) => [
                      `Replay diagnostics unavailable: ${String(error).slice(0, DIAGNOSTIC_CHARS)}`,
                    ])),
                    ...catalogDiagnostics,
                    ...(sample.followingEmails
                      ? [
                          `following Emails: ${JSON.stringify({ verified: followingVerified, sources: following })}`,
                        ]
                      : []),
                  ],
                  usage: usage.map((row) => ({
                    feature: row.feature,
                    model: row.model,
                    status: row.status,
                    standardCost: row.standardCost,
                    chargedCost: row.chargedCost,
                    gatewayLogId: row.gatewayLogId,
                    inputTokens: row.inputTokens,
                    outputTokens: row.outputTokens,
                    cacheReadTokens: row.cacheReadTokens,
                    cacheWriteTokens: row.cacheWriteTokens,
                    durationMs: row.durationMs,
                  })),
                  usd: usage.reduce<Record<string, number>>(
                    (byModel, row) => ({
                      ...byModel,
                      [row.model]:
                        (byModel[row.model] ?? 0) + (row.standardCost ?? 0),
                    }),
                    {},
                  ),
                };
              },
              record: (report) => {
                const now = Date.now();
                reports.push({
                  ...report,
                  fields: [
                    ...new Set([...report.fields, ...followingDisagreements]),
                  ],
                  seconds: {
                    startup: Math.round((admittedAt - caseStartedAt) / 1000),
                    settle: Math.round((now - admittedAt) / 1000),
                  },
                });
              },
            });
          let observedOutcome: z.infer<typeof mailImportOutcome> | null = null;
          if (scripted) {
            const scenario = await startScenarioHarness(
              ctx.databaseUrl,
              {
                steps:
                  sample.subject === syntheticAttemptLimit.subject
                    ? [
                        call("claim", "claim_next_import_work"),
                        ...scriptedReads,
                        call("invalid-extract-1", EXTRACT_ORDER_TOOL),
                        call("invalid-extract-2", EXTRACT_ORDER_TOOL),
                        call("invalid-extract-3", EXTRACT_ORDER_TOOL),
                        call("done", "claim_next_import_work"),
                      ]
                    : sample.baseline.kind === "imported"
                      ? [
                          call("claim", "claim_next_import_work"),
                          ...scriptedReads,
                          call("extract", EXTRACT_ORDER_TOOL, {
                            mail: {
                              mailboxId,
                              messageId: from("claim", "email.messageId"),
                              checksum: from("claim", "read.checksum"),
                            },
                            vendor: { name: "Synthetic Shop" },
                            extraction: {
                              status: "ready",
                              candidate: {
                                orderId: "SYN-1001",
                                sourceReferences: {
                                  orderId: "Order SYN-1001",
                                  orderedAt: "placed September 20, 2026",
                                  printedGrandTotal: "Order total: $22.89",
                                  lines: [
                                    "1 x Synthetic ceramic mug: $12.00",
                                    "2 x Synthetic tea towel at $4.50: $9.00",
                                    "Sales tax: $1.89",
                                  ],
                                  payments: [],
                                },
                                orderedAt: "2026-09-20",
                                merchant: "Synthetic Shop",
                                currency: "USD",
                                printedGrandTotal: 22.89,
                                lines: [
                                  {
                                    title: "Synthetic ceramic mug",
                                    amount: 12,
                                    quantity: 1,
                                    lineKind: "principal",
                                    costType: "tools",
                                  },
                                  {
                                    title: "Synthetic tea towel",
                                    amount: 9,
                                    quantity: 2,
                                    lineKind: "principal",
                                    costType: "materials",
                                  },
                                  {
                                    title: "Sales tax",
                                    amount: 1.89,
                                    lineKind: "tax",
                                    costType: "services",
                                  },
                                ],
                                payments: [],
                              },
                            },
                            products: [{ kind: "new" }, { kind: "new" }, null],
                          }),
                          {
                            check: "extract",
                            includes: '"nextWork":{"kind":"none"}',
                          },
                        ]
                      : [
                          call("claim", "claim_next_import_work"),
                          {
                            check: "claim",
                            includes: `synthetic-replay-${index}-0`,
                          },
                          ...scriptedReads,
                          mcp("resolve", "purchase_import", started.runId, {
                            action: "mail_resolve",
                            mailboxId,
                            messageId: from("claim", "email.messageId"),
                            checksum: from("claim", "read.checksum"),
                            disposition: {
                              kind: "unresolved",
                              reason: "Synthetic missing itemization",
                            },
                          }),
                          ...(sample.followingEmails ?? []).flatMap(
                            (_, followingIndex) => {
                              const id = `following-${followingIndex}`;
                              return [
                                call(id, "claim_next_import_work"),
                                {
                                  check: id,
                                  includes: `synthetic-replay-${index}-${followingIndex + 1}`,
                                },
                                mcp(
                                  `resolve-${id}`,
                                  "purchase_import",
                                  started.runId,
                                  {
                                    action: "mail_resolve",
                                    mailboxId,
                                    messageId: from(id, "email.messageId"),
                                    checksum: from(id, "read.checksum"),
                                    disposition: {
                                      kind: "unresolved",
                                      reason: "Synthetic missing itemization",
                                    },
                                  },
                                ),
                              ];
                            },
                          ),
                          call("done", "claim_next_import_work"),
                        ],
              },
              "purchase-agent",
              { coordinatorModels: { primary }, readCode },
            );
            diagnose = async () => {
              const attempts = await getDb(ctx.db)
                .select({
                  state: runOperation.state,
                  error: runOperation.error,
                  result: runOperation.result,
                })
                .from(runOperation)
                .where(
                  and(
                    eq(runOperation.runId, runId),
                    eq(runOperation.kind, "mail_extraction_attempt"),
                  ),
                )
                .limit(4);
              return [
                ...scenario.harness
                  .getLogs()
                  .filter((entry) => entry.level === "error")
                  .slice(-DIAGNOSTIC_LOGS)
                  .map((entry) => entry.message.slice(0, DIAGNOSTIC_CHARS)),
                `script emitted: ${JSON.stringify(await scenario.emitted())}`,
                `script violations: ${JSON.stringify(await scenario.violations())}`,
                `attempt receipts: ${JSON.stringify(attempts)}`.slice(
                  0,
                  DIAGNOSTIC_CHARS,
                ),
              ];
            };
            try {
              observedOutcome = await observe(async () => {
                await scenario.wake();
                await waitForSettlement();
                const violations = await scenario.violations();
                if (violations.length)
                  throw new Error(
                    `Scripted replay violations: ${JSON.stringify(violations)}`,
                  );
              });
            } finally {
              await scenario.close();
            }
          } else {
            const token = localSecret(["AI_GATEWAY_API_KEY"]);
            if (!token)
              throw new Error(
                "AI_GATEWAY_API_KEY is required for real coordinator replay",
              );
            const peer = {
              main: "tooling/ai/live-gateway.ts",
              vars: {
                ACCOUNT_ID: CF_ACCOUNT_ID,
                GATEWAY_ENVIRONMENT: testAiGatewayEnvironment(process.env.CI),
              },
              secrets: { GATEWAY_TOKEN: token },
            };
            if (!evaluationBudget)
              throw new Error("Live replay requires guarded admission");
            const allowances = evaluationBudget.begin(async (receiptIds) =>
              getDb(ctx.db)
                .select({
                  gatewayLogId: aiUsage.gatewayLogId,
                  model: aiUsage.model,
                  status: aiUsage.status,
                  standardCost: aiUsage.standardCost,
                  inputTokens: aiUsage.inputTokens,
                  outputTokens: aiUsage.outputTokens,
                  cacheReadTokens: aiUsage.cacheReadTokens,
                  cacheWriteTokens: aiUsage.cacheWriteTokens,
                })
                .from(aiUsage)
                .where(
                  or(
                    eq(aiUsage.runId, runId),
                    inArray(aiUsage.gatewayLogId, receiptIds),
                  ),
                ),
            );
            await withWorkerdRuntime(
              {
                profile: "purchase-agent",
                database: { borrowed: ctx.databaseUrl },
                models: {
                  agent: {
                    ...peer,
                    vars: {
                      ...peer.vars,
                      ...allowances.agent,
                      ...(sample.readFanout && {
                        READ_FANOUT_NAMES: JSON.stringify(sample.readFanout),
                        READ_FANOUT_MODE: readCode
                          ? bulkReads
                            ? "code-bulk"
                            : "code"
                          : bulkReads
                            ? "bulk"
                            : "ordinary",
                      }),
                    },
                  },
                  gateway: {
                    ...peer,
                    vars: { ...peer.vars, ...allowances.gateway },
                  },
                },
                coordinatorModels: { primary, escalation },
                readCode,
              },
              async ({ harness }) => {
                // The coordinator runs in the web Worker's Durable Object; its
                // error logs carry a failure that never reached a usage row.
                harness.clearLogs();
                diagnose = async () => {
                  const logs = harness
                    .getLogs()
                    .filter(
                      (log) =>
                        log.message.includes("[purchase-agent]") ||
                        // Better Auth's startup seed retry is not the coordinator's.
                        (log.level === "error" &&
                          !log.message.includes("[Better Auth]")),
                    )
                    .slice(-DIAGNOSTIC_LOGS)
                    .map((log) => log.message.slice(0, DIAGNOSTIC_CHARS));
                  const peer = await harness
                    .getWorker("cubby-test-model")
                    .fetch("https://model.test/usage");
                  const transcript = await harness
                    .getWorker("cubby-job-wake-producer")
                    .fetch("https://queue.test/coordinator-transcript", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        agentId: importRunAgentIdentity(runId, "mail_import"),
                      }),
                    });
                  if (!transcript.ok)
                    throw new Error(
                      `Replay transcript refused (${transcript.status})`,
                    );
                  const conversation = agentConversationSchema.parse(
                    await transcript.json(),
                  );
                  const toolParts = [
                    ...new Map(
                      conversation.messages
                        .flatMap((message) => message.parts)
                        .filter((part) => part.type === "tool")
                        .map((part) => [part.toolCallId, part]),
                    ).values(),
                  ];
                  const calls = toolParts.filter(
                    (part) => part.toolName === "codemode",
                  );
                  const toolUsage = Object.fromEntries(
                    [...new Set(toolParts.map((part) => part.toolName))].map(
                      (name) => {
                        const selected = toolParts.filter(
                          (part) => part.toolName === name,
                        );
                        return [
                          name,
                          {
                            calls: selected.length,
                            errors: selected.filter(
                              (part) => part.state === "output-error",
                            ).length,
                          },
                        ];
                      },
                    ),
                  );
                  const fanoutDiagnostics: string[] = [];
                  if (sample.readFanout) {
                    const returnedNames: string[] = [];
                    const nestedNames: string[] = [];
                    let successfulNestedReads = 0;
                    const inspect = (value: unknown): void => {
                      if (typeof value === "string") {
                        try {
                          inspect(JSON.parse(value));
                        } catch {
                          /* SILENT: ordinary prose is not a structured result. */
                          if (value.includes("\n"))
                            value.split("\n").forEach(inspect);
                        }
                      } else if (Array.isArray(value)) value.forEach(inspect);
                      else if (value && typeof value === "object") {
                        const matches = z
                          .object({
                            fanoutMatches: z.array(
                              z.object({ name: z.string() }),
                            ),
                          })
                          .safeParse(value);
                        if (matches.success)
                          returnedNames.push(
                            ...matches.data.fanoutMatches.map(
                              (row) => row.name,
                            ),
                          );
                        const summary = z
                          .object({
                            calls: z.array(
                              z.object({
                                name: z.string(),
                                status: z.string(),
                                args: z.string(),
                              }),
                            ),
                          })
                          .safeParse(value);
                        if (summary.success) {
                          const successful = summary.data.calls.filter(
                            (row) =>
                              row.name === "mcp__cubby__entity_read" &&
                              row.status === "ok",
                          );
                          successfulNestedReads += successful.length;
                          for (const call of successful) {
                            let args: unknown;
                            try {
                              args = JSON.parse(call.args);
                            } catch {
                              // SILENT: truncated native previews cannot verify a requested name.
                              continue;
                            }
                            const query = z
                              .object({
                                action: z.literal("resolve"),
                                entity: z.literal("product"),
                                names: z.array(z.string()),
                              })
                              .safeParse(args);
                            if (query.success)
                              nestedNames.push(...query.data.names);
                          }
                        }
                        Object.values(value).forEach(inspect);
                      }
                    };
                    calls.forEach((part) => {
                      if (part.type === "tool") inspect(part.output);
                    });
                    const directNames = toolParts.flatMap((part) => {
                      if (
                        part.type !== "tool" ||
                        part.toolName !== "mcp__cubby__entity_read" ||
                        part.state !== "output-available"
                      )
                        return [];
                      const query = z
                        .object({
                          action: z.literal("resolve"),
                          entity: z.literal("product"),
                          names: bulkReads
                            ? z.array(z.string()).length(8)
                            : z.array(z.string()).length(1),
                        })
                        .safeParse(part.input);
                      return query.success ? query.data.names : [];
                    });
                    const observed = readCode ? returnedNames : directNames;
                    fanoutVerified =
                      sample.readFanout.every((name) =>
                        observed.includes(name),
                      ) &&
                      (!readCode ||
                        (successfulNestedReads ===
                          (bulkReads ? 1 : sample.readFanout.length) &&
                          sample.readFanout.every((name) =>
                            nestedNames.includes(name),
                          )));
                    fanoutDiagnostics.push(
                      `read fanout: ${JSON.stringify({ verified: fanoutVerified, directNames, returnedNames, nestedNames, successfulNestedReads })}`,
                    );
                    if (!fanoutVerified)
                      fanoutDiagnostics.push(
                        `read fanout tool evidence: ${JSON.stringify(calls).slice(0, 16000)}`,
                      );
                  }
                  return [
                    ...logs,
                    ...fanoutDiagnostics,
                    `tool usage: ${JSON.stringify(toolUsage)}`,
                    `request context: ${JSON.stringify(conversation.messages.flatMap((message) => message.metadata?.contextBreakdown?.calls ?? []))}`,
                    `peer usage: ${await peer.text()}`,
                    `code usage: ${JSON.stringify({ calls: calls.length, errors: calls.filter((part) => part.state === "output-error").length, failures: calls.filter((part) => part.state === "output-error").map((part) => part.errorText?.slice(0, DIAGNOSTIC_CHARS)) })}`,
                  ];
                };
                observedOutcome = await observe(async () => {
                  try {
                    const response = await harness
                      .getWorker("cubby-job-wake-producer")
                      .fetch("https://queue.test/wake", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: "{}",
                      });
                    if (!response.ok)
                      throw new Error(
                        `Replay dispatch refused (${response.status})`,
                      );
                    await waitForSettlement();
                  } finally {
                    // Flush exact physical receipts before the report reads
                    // usage, while this case's database still exists.
                    await evaluationBudget.finish();
                  }
                });
              },
            );
          }
          expect(observedOutcome).not.toBeNull();
          expect(
            !sample.followingEmails || followingVerified,
            "Every Email in the Run must retain its disposition and monetary facts",
          ).toBe(true);
          expect(
            !sample.catalogProducts || catalogVerified,
            "Catalog-backed imports must reuse existing Products without duplicates",
          ).toBe(true);
          expect(
            !sample.readFanout || fanoutVerified,
            "The live model must complete the configured independent read workload",
          ).toBe(true);
          // Private cases retain report-only grading. Synthetic facts must
          // agree; free-form gap wording is not a different disposition.
          const requiredDisagreements =
            inputUrl && !sample.readFanout
              ? []
              : mailReplayDisagreement(sample.baseline, observedOutcome).filter(
                  (field) => field !== "reason" && field !== "lines",
                );
          expect(requiredDisagreements).toEqual([]);
        } catch (error) {
          if (!reports.some((report) => report.case === index + 1))
            reports.push(unavailable(index + 1, String(error)));
          throw error;
        } finally {
          queueCapture.restore();
        }
      },
      CASE_BUDGET_MS,
    );
});
