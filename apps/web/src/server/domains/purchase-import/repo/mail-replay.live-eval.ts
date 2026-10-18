import { mailImportOutcome } from "@cubby/schemas/assessment";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
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
import { withWorkerdRuntime } from "tooling/workerd-runtime";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { aiUsage, assessment, run as runTable } from "~/server/db/schema";
import { captureBackgroundQueue } from "~/server/testing/background-queue";

import {
  memberImportWorld,
  retainedMailFixture,
} from "../operations/order-import.fixtures";
import { mailReplayDisagreement } from "../service/mail-replay-report";
import { startMailImport } from "./mail-import-run";
import {
  authorizePurchaseAgent,
  enableSyntheticMailImport,
  startScenarioHarness,
  waitFor,
} from "./purchase-agent-workerd.fixtures";

/** Source originals arrive over an ephemeral loopback socket, never files or argv. */
const replayCases = z
  .array(
    z.object({
      subject: z.string().nullable(),
      sender: z.string().nullable(),
      receivedAt: z.iso.datetime(),
      bodyText: z.string(),
      bodyHtml: z.string().nullable().default(null),
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
const synthetic = [
  {
    subject: "Synthetic order inquiry",
    sender: "orders@shop.example",
    receivedAt: "2026-09-20T18:00:00Z",
    bodyText: "Synthetic inquiry: no order id, itemization or amount.",
    baseline: { kind: "unresolved", reason: "Synthetic missing itemization" },
  },
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
const primary = supportedChatModelSchema.parse(
  process.env.MAIL_REPLAY_MODEL ?? "claude-opus-5-5",
);
const escalation = process.env.MAIL_REPLAY_ESCALATION_MODEL
  ? supportedChatModelSchema.parse(process.env.MAIL_REPLAY_ESCALATION_MODEL)
  : undefined;
const reports: {
  case: number;
  fields: string[];
  status: string;
  actualModels: string[];
}[] = [];

// Failure modes: replay reaches production data or Gmail; two cases share
// ledger writes; comparison publishes grades; a missing outcome counts as parity.
describe("isolated Mail coordinator replay", () => {
  const ctx = withTestDb(); // A fresh throwaway database for each case.
  afterAll(() => {
    for (const [index] of cases.entries()) {
      if (!reports.some((report) => report.case === index + 1))
        reports.push({
          case: index + 1,
          fields: ["unavailable"],
          status: "infrastructure_error",
          actualModels: [],
        });
    }
    reports.sort((a, b) => a.case - b.case);
    const disagreements = reports.filter((report) => report.fields.length);
    console.log(
      JSON.stringify({
        kind: "mail-import-replay",
        synthetic: !inputUrl,
        scripted,
        primary,
        escalation: escalation ?? null,
        cases: reports.length,
        parity: reports.length - disagreements.length,
        actualModels: [
          ...new Set(reports.flatMap((report) => report.actualModels)),
        ],
        requestedPrimaryObservedCases: reports.filter((report) =>
          report.actualModels.includes(primary),
        ).length,
        disagreements,
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
        const queueCapture = captureBackgroundQueue();
        try {
          const { party } = await memberImportWorld(ctx.db, ctx.actor);
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
              }),
            ),
            content: {
              snippet: null,
              bodyText: sample.bodyText,
              bodyHtml: sample.bodyHtml,
            },
            classificationVersion: "isolated-replay-v1",
          });
          await enableSyntheticMailImport(ctx, mailboxId);
          await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
          const events: PurchaseAgentEvent[] = [];
          const [started] = await startMailImport(
            ctx.db,
            {
              ledgerPartyId: party.id,
              userId: ctx.actor.userId,
              messageIds: [mail.id],
            },
            {
              send: async (event: PurchaseAgentEvent) => {
                events.push(event);
              },
            },
          );
          if (!started || !events[0])
            throw new Error(
              "Replay admission did not produce a coordinator event",
            );
          const runId = parseEntityId("run", started.runId);
          const collect = async () => {
            let status = "running";
            await waitFor(
              async () => {
                const [row] = await getDb(ctx.db)
                  .select({ status: runTable.status })
                  .from(runTable)
                  .where(eq(runTable.id, runId));
                status = row?.status ?? "missing";
                return status !== "running";
              },
              "Replay coordinator did not settle within its time budget",
              scripted ? 30_000 : 8 * 60_000,
            );
            const [outcome] = await getDb(ctx.db)
              .select({ judgment: assessment.judgment })
              .from(assessment)
              .where(and(eq(assessment.family, "mail_import_outcome")))
              .orderBy(desc(assessment.createdAt), desc(assessment.id))
              .limit(1);
            const usage = await getDb(ctx.db)
              .select({ model: aiUsage.model })
              .from(aiUsage)
              .where(
                and(
                  eq(aiUsage.runId, runId),
                  eq(aiUsage.feature, "purchase_import_agent"),
                  eq(aiUsage.status, "succeeded"),
                ),
              );
            reports.push({
              case: index + 1,
              status,
              fields: mailReplayDisagreement(
                sample.baseline,
                outcome ? mailImportOutcome.parse(outcome.judgment) : null,
              ),
              actualModels: [...new Set(usage.map((row) => row.model))],
            });
            expect(Boolean(outcome)).toBe(true);
          };
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
              await scenario.dispatch(events[0]);
              await collect();
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
              main: "tooling/tester-army/live-gateway.ts",
              vars: {
                ACCOUNT_ID: CF_ACCOUNT_ID,
                GATEWAY_ENVIRONMENT: testAiGatewayEnvironment(process.env.CI),
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
                const response = await harness
                  .getWorker("cubby-queue-producer")
                  .fetch("https://queue.test/dispatch", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(events[0]),
                  });
                if (!response.ok)
                  throw new Error(
                    `Replay dispatch refused (${response.status})`,
                  );
                await collect();
              },
            );
          }
        } finally {
          queueCapture.restore();
        }
      },
      10 * 60_000,
    );
});
