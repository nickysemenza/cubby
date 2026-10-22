import { mailImportOutcome } from "@cubby/schemas/assessment";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { importRunAgentManifest } from "@cubby/schemas/import-run-agent";
import { mailAttributionHeaders } from "@cubby/schemas/mailbox-research";
import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import {
  CF_ACCOUNT_ID,
  testAiGatewayEnvironment,
} from "@cubby/shared/ai/gateway-metadata";
import { supportedChatModelSchema } from "@cubby/shared/ai/models";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, desc, eq } from "drizzle-orm";
import { localSecret } from "tooling/local-secret";
import { call, from, mcp } from "tooling/purchase-agent-script";
import { withTestDb } from "tooling/test-setup";
import { holdWorkerdHarness } from "tooling/workerd-harness";
import { withWorkerdRuntime } from "tooling/workerd-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { user } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import { aiUsage, assessment, job, run as runTable } from "~/server/db/schema";
import { captureBackgroundQueue } from "~/server/testing/background-queue";

import {
  memberImportWorld,
  retainedMailFixture,
} from "../../operations/order-import.fixtures";
import {
  observeMailReplayAttempt,
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
const replayCases = z
  .array(
    z.object({
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
      owner: z
        .object({ name: z.string().min(1), address: z.email() })
        .optional(),
      baseline: mailImportOutcome,
    }),
  )
  .min(1)
  .max(100);
const scripted = process.env.MAIL_REPLAY_SCRIPTED === "1";
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
// The scripted coordinator resolves every Email unresolved.
const synthetic = scripted
  ? [syntheticInquiry]
  : [syntheticInquiry, syntheticOwnOrder];
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
  // A stale Worker rebuild takes minutes; it must not spend a case's budget.
  beforeAll(async () => {
    const release = await holdWorkerdHarness();
    await release();
  }, 30 * 60_000);
  afterAll(() => {
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
        synthetic: !inputUrl,
        scripted,
        primary,
        escalation,
        cases: reports.length,
        parity: reports.length - disagreements.length,
        actualModels: [
          ...new Set(reports.flatMap((report) => report.actualModels)),
        ],
        requestedPrimaryObservedCases: reports.filter((report) =>
          report.actualModels.includes(primary),
        ).length,
        disagreements,
        /** Standard (list-price) coordinator cost per case, every case. */
        usd: reports.map((report) => ({
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
        const queueCapture = captureBackgroundQueue();
        try {
          const { party } = await memberImportWorld(ctx.db, ctx.actor, {
            memberName: sample.owner?.name,
          });
          // Owner evidence is the member's sign-in address (the Gmail profile
          // is unreachable), so it carries the original recipient's address.
          if (sample.owner)
            await getDb(ctx.db)
              .update(user)
              .set({ email: sample.owner.address })
              .where(eq(user.id, ctx.actor.userId));
          const mailboxId = "synthetic-replay-mailbox";
          const mail = await retainedMailFixture(ctx.db, {
            ledgerPartyId: party.id,
            mailboxId,
            messageId: `synthetic-replay-${index}`,
            subject: sample.subject,
            sender: sample.sender,
            receivedAt: new Date(sample.receivedAt),
            checksum: await sha256Hex(
              JSON.stringify({
                bodyText: sample.bodyText,
                bodyHtml: sample.bodyHtml,
                headers: sample.headers,
              }),
            ),
            content: {
              snippet: null,
              bodyText: sample.bodyText,
              bodyHtml: sample.bodyHtml,
              ...(sample.headers && { headers: sample.headers }),
            },
            classificationVersion: "isolated-replay-v1",
          });
          await enableSyntheticMailImport(ctx, mailboxId);
          await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
          const [started] = await startMailImport(ctx.db, {
            ledgerPartyId: party.id,
            userId: ctx.actor.userId,
            messageIds: [mail.id],
          });
          const [dispatch] = await getDb(ctx.db)
            .select()
            .from(job)
            .where(eq(job.runId, parseEntityId("run", started!.runId)));
          const event = dispatch
            ? purchaseAgentEvent.parse(dispatch.input)
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
                const [outcome] = await getDb(ctx.db)
                  .select({ judgment: assessment.judgment })
                  .from(assessment)
                  .where(eq(assessment.family, "mail_import_outcome"))
                  .orderBy(desc(assessment.createdAt), desc(assessment.id))
                  .limit(1);
                const usage = await getDb(ctx.db)
                  .select({
                    model: aiUsage.model,
                    status: aiUsage.status,
                    transport: aiUsage.transport,
                    failure: aiUsage.failure,
                    standardCost: aiUsage.standardCost,
                  })
                  .from(aiUsage)
                  .where(
                    and(
                      eq(aiUsage.runId, runId),
                      eq(aiUsage.feature, "purchase_import_agent"),
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
                return {
                  status,
                  failure:
                    failed?.code || failed?.detail
                      ? [failed.code, failed.detail].filter(Boolean).join(": ")
                      : null,
                  outcome: outcome
                    ? mailImportOutcome.parse(outcome.judgment)
                    : null,
                  actualModels: usage
                    .filter((row) => row.status === "succeeded")
                    .map((row) => row.model),
                  failedAttempts: usage
                    .filter((row) => row.status !== "succeeded")
                    .map((row) =>
                      `${row.model} (${row.transport}): ${row.failure ?? row.status}`.slice(
                        0,
                        DIAGNOSTIC_CHARS,
                      ),
                    ),
                  diagnostics: await diagnose(),
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
                steps: [
                  call("claim", "claim_next_import_work"),
                  mcp("resolve", "mail", started.runId, {
                    action: "resolve",
                    mailboxId,
                    messageId: from("claim", "email.messageId"),
                    checksum: from("claim", "read.checksum"),
                    disposition: {
                      kind: "unresolved",
                      reason: "Synthetic missing itemization",
                    },
                  }),
                  call("done", "claim_next_import_work"),
                ],
              },
              "purchase-agent",
              { coordinatorModels: { primary } },
            );
            try {
              observedOutcome = await observe(async () => {
                await scenario.wake();
                await waitForSettlement();
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
                // Paid replay: ChatGPT plan attempts bill to Unified Billing.
                ...(process.env.MAIL_REPLAY_PLAN_AS_PAID === "1" && {
                  PLAN_AS_PAID: "1",
                }),
              },
              secrets: { GATEWAY_TOKEN: token },
            };
            await withWorkerdRuntime(
              {
                profile: "purchase-agent",
                database: { borrowed: ctx.databaseUrl },
                models: { agent: peer, gateway: peer },
                coordinatorModels: { primary, escalation },
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
                  return [...logs, `peer usage: ${await peer.text()}`];
                };
                observedOutcome = await observe(async () => {
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
                });
              },
            );
          }
          expect(observedOutcome).not.toBeNull();
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
