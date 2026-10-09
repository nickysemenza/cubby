import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import { fieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { productWithFoodOut } from "@cubby/schemas/product";
import { productResearchRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { makeSignature } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import {
  evalCandidates,
  evalSubscriptionOutputTokens,
  evalUsageReport,
  evalWebRoot,
  subscriptionEvalModelWorker,
} from "tooling/ai/eval-support";
import {
  captureE2ERunIdentity,
  writeE2ERunBundle,
} from "tooling/e2e-run-bundle";
import { startLocalChatGptProvider } from "tooling/local-chatgpt-provider";
import { createE2EObjectStorage } from "tooling/local-object-storage";
import {
  mailEvalCategoryName,
  mailEvalMailboxId,
  mailEvalMessages,
  mailEvalOrderId,
  mailEvalOriginals,
  mailEvalPage,
} from "tooling/purchase-mail-eval.fixtures";
import type { ResearchEvalPeerConfiguration } from "tooling/research-eval-peer";
import { withTestDb } from "tooling/test-setup";
import { readWebBuildProvenance } from "tooling/web-build-provenance";
import {
  withWorkerdRuntime,
  type WorkerdRuntime,
} from "tooling/workerd-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { GMAIL_READONLY_SCOPE } from "~/lib/google-auth-constants";
import { toWire } from "~/lib/http-api/wire";
import type { Database } from "~/server/db";
import { account as googleAccount } from "~/server/db/auth.schema";
import {
  entityAttachment,
  entityExternalId,
  expense,
  financialTransaction,
  financialTransactionAllocation,
  inventoryEntry,
  mailboxMessage,
  orderMail,
  orderMailCandidateDecision,
  orderMailEvent,
  product,
  purchase,
  run,
  runEvidence,
  runFactEvidence,
  runOperation,
  runTarget,
  session,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { issueExecutionAuthorization } from "~/server/runs/execution-authorization";

import { loadCurrentFactEvidence } from "./fact-verification";
import {
  authorizePurchaseAgent,
  workerdDiagnostic,
} from "./purchase-agent-workerd.fixtures";
import { waitForResearchEvalSettlement } from "./purchase-research-eval.fixtures";
import { loadProductResearchCoverage } from "./research-projection";

// Failures: lifecycle mail makes a second Purchase, the automatic child is
// skipped, the wrong variant is accepted, values lack retained/visible proof,
// shipment changes money or stock, or exhausted inference masquerades as success.
// Only source transport and measured Jev decisions are fixed; proposals and
// source-support assessments both run through the required real subscription.
const candidates = evalCandidates("gpt-6-sol:high");
const candidate = candidates[0];
if (candidates.length !== 1 || !candidate || !/sol|luna/u.test(candidate.model))
  throw new Error(
    "This bounded mail evaluation requires exactly one Luna/Sol candidate",
  );
const caseWallMs = 480_000;
const aggregate = {
  requests: z.coerce
    .number()
    .int()
    .min(12)
    .max(32)
    .parse(process.env.AGENT_EVAL_MAX_REQUESTS ?? 24),
  tokens: z.coerce
    .number()
    .int()
    .min(96_000)
    .max(4_096_000)
    .parse(process.env.AGENT_EVAL_MAX_TOKENS ?? 3_072_000),
};
const budgetReport = z.object({
  requests: z.number(),
  reservedTokens: z.number(),
  refusedRequests: z.number(),
  wallLimitMs: z.number(),
  remainingWallMs: z.number(),
});
const ended = new Set([
  "completed",
  "needs_review",
  "failed",
  "cancelled",
  "dispatch_failed",
  "client_update_required",
]);
const repoRoot = path.resolve(evalWebRoot, "../..");
const replayCommand = `AGENT_EVAL_CANDIDATES='${candidate.model}:${candidate.effort}' AGENT_EVAL_MAX_REQUESTS=${aggregate.requests} AGENT_EVAL_MAX_TOKENS=${aggregate.tokens} pnpm --dir ${evalWebRoot} eval:purchase-mail`;

async function snapshot(db: Database) {
  const client = getDb(db);
  const [
    runs,
    targets,
    operations,
    originals,
    ledger,
    decisions,
    events,
    purchases,
    expenses,
    products,
    proofs,
    evidence,
    attachments,
    identifiers,
  ] = await Promise.all([
    client.select().from(run),
    client.select().from(runTarget),
    client.select().from(runOperation),
    client.select().from(orderMail),
    client.select().from(mailboxMessage),
    client.select().from(orderMailCandidateDecision),
    client.select().from(orderMailEvent),
    client.select().from(purchase),
    client.select().from(expense),
    client.select().from(product),
    client.select().from(runFactEvidence),
    client.select().from(runEvidence),
    client.select().from(entityAttachment),
    client.select().from(entityExternalId),
  ]);
  return {
    runs,
    targets,
    operations,
    originals,
    ledger,
    decisions,
    events,
    purchases,
    expenses,
    products,
    proofs,
    evidence,
    attachments,
    identifiers,
  };
}

async function authenticate(db: Database, actorUserId: string) {
  const token = `synthetic-mail-eval-${crypto.randomUUID()}`;
  const now = new Date();
  await getDb(db)
    .insert(session)
    .values({
      id: crypto.randomUUID(),
      token,
      userId: actorUserId,
      expiresAt: new Date(now.getTime() + caseWallMs + 120_000),
      createdAt: now,
      updatedAt: now,
    });
  const signature = await makeSignature(
    token,
    process.env.BETTER_AUTH_SECRET || "e2e-test-secret",
  );
  return {
    cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
  };
}

const diagnostic = z.discriminatedUnion("status", [
  z.object({ status: z.literal("fulfilled"), value: z.json() }),
  z.object({ status: z.literal("rejected"), error: z.string() }),
]);
type MailEvalObservations = {
  build?: ReturnType<typeof readWebBuildProvenance>;
  launch?: { status: number; body: string };
  settlement?: string;
  state?: Awaited<ReturnType<typeof snapshot>>;
  coverage?: Awaited<ReturnType<typeof loadProductResearchCoverage>>;
  productHTTP?: { status: number; body: string };
  explanations?: { field: string; status: number; body: string }[];
  usages?: z.infer<typeof evalUsageReport>[];
  budgets?: z.infer<typeof budgetReport>[];
  providerRequests?: ReturnType<
    NonNullable<WorkerdRuntime["googleProvider"]>["requests"]
  >;
  exitState?: Awaited<ReturnType<typeof snapshot>>;
  exitDiagnostics?: z.infer<typeof diagnostic>[];
  cleanupErrors?: string[];
  failure?: string;
};

describe("bounded real Gmail purchase and Product research", () => {
  const ctx = withTestDb();
  it(
    "converges confirmation and shipment into one Purchase and automatically retains real supported Product proof",
    async () => {
      const started = captureE2ERunIdentity(repoRoot);
      const begin = Date.now();
      const outDir = path.join(
        repoRoot,
        "artifacts/purchase-mail-research-eval",
        new Date().toISOString().replace(/[:.]/gu, "-"),
      );
      mkdirSync(outDir, { recursive: true });
      const reportPath = path.join(outDir, "report.json");
      const report = {
        synthetic: true,
        status: "failed",
        phase: "setup",
        candidate,
        replayCommand,
        aggregate,
        caseWallMs,
        transport: "chatgpt",
        separatelyBilledApiCostUsd: 0,
        real: [
          "Gmail acquisition and queue orchestration",
          "mail and automatic Product researcher decisions",
          "source-support assessor",
          "bounded domain writes",
          "retained evidence and HTTP proof",
        ],
        seams: [
          "synthetic OAuth/Gmail original transport",
          "public source search/page transport",
          "live category catalog read with no search document",
          "all measured closed-set Jev decisions scripted",
        ],
        limits: [
          "one synthetic seller/order and two HTML originals with oversized layout styles",
          "text-only inference; no positive image acceptance",
          "missing image coverage must remain explicit",
          "no live household data or production",
          "subscription model snapshot not pinned",
          "request-byte plus catalog maximum-output reservations, not reported tokens",
        ],
        fixture: { originals: mailEvalOriginals, page: mailEvalPage },
      };
      const observations: MailEvalObservations = {};
      const writeReport = () =>
        writeFileSync(
          reportPath,
          `${JSON.stringify({ ...report, ...observations }, null, 2)}\n`,
        );
      writeReport();
      let subscription:
        | Awaited<ReturnType<typeof startLocalChatGptProvider>>
        | undefined;
      let storage:
        | Awaited<ReturnType<typeof createE2EObjectStorage>>
        | undefined;
      try {
        const party = await insertWithShortcode(ctx.db, "ledgerParty", {
          name: "Synthetic live research member",
          kind: "member",
          userId: ctx.actor.userId,
        });
        await insertWithShortcode(ctx.db, "vendor", {
          name: "Example Works",
          website: "https://maker.example.test",
          browserDomains: ["maker.example.test"],
        });
        const category = await insertWithShortcode(ctx.db, "productCategory", {
          name: mailEvalCategoryName,
          parentId: null,
          feature: null,
          emoji: null,
          sortOrder: 0,
          spendingCategoryMode: "inherit",
          spendingCategoryId: null,
        });
        await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
        await getDb(ctx.db)
          .insert(googleAccount)
          .values({
            id: crypto.randomUUID(),
            accountId: mailEvalMailboxId,
            providerId: "google",
            userId: ctx.actor.userId,
            accessToken: "synthetic-mail-access",
            refreshToken: "synthetic-mail-refresh",
            scope: GMAIL_READONLY_SCOPE,
            accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
          });
        const approval = await issueExecutionAuthorization(
          ctx.db,
          ctx.actor,
          executionAuthorizationInput.parse({
            kind: "execution_authorization",
            version: 1,
            owner: { userId: ctx.actor.userId, ledgerPartyId: party.id },
            scope: {
              kind: "backfill",
              mailboxId: mailEvalMailboxId,
              discovery: "all_history",
            },
            meteredBudget: { period: "lifetime", limitMicroUSD: 1_000_000 },
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
        const database = getDb(ctx.db);
        const baseline = {
          transactions: await database.select().from(financialTransaction),
          allocations: await database
            .select()
            .from(financialTransactionAllocation),
          stock: await database.select().from(inventoryEntry),
        };
        const headers = await authenticate(ctx.db, ctx.actor.userId);
        subscription = await startLocalChatGptProvider();
        const peer = subscriptionEvalModelWorker(subscription.origin);
        const maxModelOutputTokens = await evalSubscriptionOutputTokens(
          candidate.model,
        );
        storage = await createE2EObjectStorage();
        const objects = storage;
        await withWorkerdRuntime(
          {
            profile: "gmail-research",
            database: { borrowed: ctx.databaseUrl },
            objectStorage: {
              borrowed: { endpoint: objects.url, publicUrl: objects.url },
            },
            models: {
              agent: {
                ...peer,
                main: "tooling/research-eval-peer.ts",
                vars: { ...peer.vars, ROLE: "researcher" },
              },
              gateway: {
                ...peer,
                main: "tooling/purchase-mail-eval-peer.ts",
                vars: { ...peer.vars, ROLE: "assessor" },
              },
            },
          },
          async (runtime) => {
            if (!runtime.googleProvider)
              throw new Error(
                "Gmail research profile lacks its synthetic provider",
              );
            const researcher = runtime.harness.getWorker("cubby-test-model");
            const assessor = runtime.harness.getWorker("cubby-test-gateway");
            const configure = async (
              worker: typeof researcher,
              role: "researcher" | "assessor",
            ) => {
              const proportion = role === "researcher" ? 2 / 3 : 1 / 3;
              const configuration: ResearchEvalPeerConfiguration = {
                ...candidate,
                sources: role === "assessor" ? [mailEvalPage] : [],
                limits: {
                  requests: Math.floor(aggregate.requests * proportion),
                  tokens: Math.floor(aggregate.tokens * proportion),
                  outputTokens: 4_000,
                  maxModelOutputTokens,
                  wallMs: caseWallMs,
                },
              };
              const response = await worker.fetch(
                "https://eval.test/configure",
                { method: "POST", body: JSON.stringify(configuration) },
              );
              if (!response.ok) throw new Error(await response.text());
            };
            const readBudgets = async () =>
              Promise.all(
                [researcher, assessor].map(async (worker) =>
                  budgetReport.parse(
                    await (
                      await worker.fetch("https://eval.test/budget")
                    ).json(),
                  ),
                ),
              );
            try {
              const build = readWebBuildProvenance(repoRoot);
              observations.build = build;
              expect({
                fresh: build.sourceFresh,
                reason: build.details.reason,
              }).toMatchObject({ fresh: true });
              await configure(researcher, "researcher");
              await configure(assessor, "assessor");
              runtime.googleProvider.configure({
                email: "synthetic-mail-eval@example.test",
                message: mailEvalMessages[0]!,
                classification: { events: [] },
                mailbox: {
                  historyId: "100",
                  messages: mailEvalMessages,
                  pages: [mailEvalMessages.map((message) => message.id)],
                  history: [],
                },
              });
              report.phase = "research";
              const launch = await fetch(
                `${runtime.origin}/api/v1/maintenance/requestCatchUp`,
                {
                  method: "POST",
                  headers: {
                    ...headers,
                    origin: runtime.origin,
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({}),
                },
              );
              const launchBody = await launch.text();
              observations.launch = { status: launch.status, body: launchBody };
              expect(launch.status).toBe(200);
              expect(
                z
                  .object({ status: z.literal("queued") })
                  .parse(JSON.parse(launchBody)),
              ).toEqual({ status: "queued" });
              observations.settlement = await waitForResearchEvalSettlement({
                begin: Date.now(),
                timeoutMs: caseWallMs,
                readBudgets,
                readState: async () => {
                  const rows = await database
                    .select()
                    .from(run)
                    .where(eq(run.ledgerPartyId, party.id));
                  const mail = rows.filter(
                    (row) => row.purpose === "mail_import",
                  );
                  const children = rows.filter(
                    (row) => row.purpose === "product_enrichment",
                  );
                  if (
                    rows.some((row) =>
                      [
                        "failed",
                        "cancelled",
                        "dispatch_failed",
                        "client_update_required",
                        "paused_auth",
                      ].includes(row.status),
                    )
                  )
                    return "failed";
                  return mail.length &&
                    [...mail, ...children].every(
                      (row) => row.endedAt && ended.has(row.status),
                    )
                    ? "settled"
                    : null;
                },
              });
              const state = await snapshot(ctx.db);
              observations.state = state;
              expect(observations.settlement).toBe("settled");
              const mailRuns = state.runs.filter(
                (row) => row.purpose === "mail_import",
              );
              expect(mailRuns.length).toBeGreaterThan(0);
              expect(
                mailRuns.every(
                  (row) => row.status === "completed" && row.endedAt,
                ),
              ).toBe(true);
              const orders = state.purchases.filter(
                (row) => row.orderId === mailEvalOrderId,
              );
              expect(orders).toHaveLength(1);
              const savedPurchase = orders[0]!;
              const originals = state.originals.filter(
                (row) => row.mailboxId === mailEvalMailboxId,
              );
              expect(originals.map((row) => row.messageId).sort()).toEqual(
                mailEvalOriginals.map((row) => row.id).sort(),
              );
              for (const original of originals) {
                const events = state.events.filter(
                  (event) => event.orderMailId === original.id,
                );
                const links = state.decisions.filter(
                  (decision) =>
                    events.some((event) => event.id === decision.eventId) &&
                    decision.decision === "linked",
                );
                expect(links.length).toBeGreaterThan(0);
                expect(
                  links.every(
                    (link) =>
                      link.purchaseId === savedPurchase.id &&
                      link.evidenceChecksum === original.rawChecksum,
                  ),
                ).toBe(true);
              }
              const shipment = originals.find(
                (row) => row.messageId === "synthetic-live-shipment",
              )!;
              expect(
                state.events.some(
                  (event) =>
                    event.orderMailId === shipment.id &&
                    event.event === "shipped",
                ),
              ).toBe(true);
              const lines = state.expenses.filter(
                (line) => line.purchaseId === savedPurchase.id,
              );
              expect(lines).toHaveLength(1);
              expect(
                lines.reduce((sum, line) => sum + Number(line.cost), 0),
              ).toBe(24);
              const savedProduct = state.products.find(
                (row) => row.id === lines[0]!.productId,
              );
              if (!savedProduct)
                throw new Error("Supported order did not create its Product");
              expect(savedProduct).toMatchObject({
                manufacturer: "Example Works",
                model: "P-20-SB",
                categoryId: category.id,
                ingredientId: null,
                growsPlantId: null,
              });
              const productIdentifiers = state.identifiers.filter(
                (row) =>
                  row.entityKind === "product" &&
                  row.entityId === savedProduct.id,
              );
              expect(
                productIdentifiers.some(
                  (identifier) =>
                    identifier.kind === "retailer_sku" &&
                    identifier.externalId === "FAN-SM-BL",
                ),
              ).toBe(true);
              for (const identifier of productIdentifiers) {
                // The maker assigns its own exact small-blue model number;
                // neither the alternate variant nor cross-kind IDs are valid.
                expect([
                  {
                    kind: "retailer_sku",
                    externalId: "FAN-SM-BL",
                    source: "host-6d616b65722e6578616d706c652e74657374",
                  },
                  {
                    kind: "manufacturer_part",
                    externalId: "P-20-SB",
                    source: "example-works",
                  },
                ]).toContainEqual({
                  kind: identifier.kind,
                  externalId: identifier.externalId,
                  source: identifier.source,
                });
                expect(identifier.url).toBe(mailEvalPage.url);
              }
              const child = state.runs.find(
                (row) =>
                  row.purpose === "product_enrichment" &&
                  state.runs.some(
                    (parent) =>
                      parent.id === row.parentRunId &&
                      parent.purpose === "mail_import",
                  ),
              );
              if (!child)
                throw new Error("Automatic Product research child missing");
              expect(
                productResearchRunInput.parse(child.input)
                  .executionAuthorization,
              ).toEqual(approval);
              expect(child.status).toBe("needs_review");
              expect(
                state.operations.some(
                  (operation) =>
                    operation.runId === child.id &&
                    operation.kind === "research_find" &&
                    operation.state === "completed" &&
                    z
                      .object({
                        results: z.array(
                          z.object({
                            entityKind: z.literal("productCategory"),
                            id: z.string(),
                          }),
                        ),
                      })
                      .safeParse(operation.result)
                      .data?.results.some(
                        (result) => result.id === category.shortcode,
                      ),
                ),
              ).toBe(true);
              const target = state.targets.find(
                (row) =>
                  row.runId === child.id && row.entityId === savedProduct.id,
              );
              if (!target)
                throw new Error(
                  "Automatic child lacks its admitted Product task",
                );
              for (const fieldPath of ["manufacturer", "model", "categoryId"]) {
                const currentProofs = await loadCurrentFactEvidence(ctx.db, {
                  entityKind: "product",
                  entityId: savedProduct.shortcode,
                  fieldPath,
                  ledgerPartyId: party.id,
                });
                expect(
                  currentProofs.some(
                    (proof) =>
                      proof.run.entityId === child.shortcode &&
                      proof.subject.entityId === savedProduct.shortcode,
                  ),
                ).toBe(true);
                expect(
                  state.proofs.some(
                    (proof) =>
                      proof.fieldPath === fieldPath &&
                      proof.targetId === target.id &&
                      state.evidence.some(
                        (source) =>
                          source.id === proof.evidenceId &&
                          source.targetId === target.id &&
                          source.runId === child.id,
                      ),
                  ),
                ).toBe(true);
              }
              const coverage = await loadProductResearchCoverage(ctx.db, {
                productId: savedProduct.id,
                ledgerPartyId: party.id,
              });
              observations.coverage = coverage;
              expect(coverage.complete).toBe(false);
              expect(coverage.missingFields).toContain("images");
              expect(
                state.attachments.filter(
                  (row) =>
                    row.entityKind === "product" &&
                    row.entityId === savedProduct.id,
                ),
              ).toEqual([]);
              const retainedPages = state.evidence.filter(
                (row) =>
                  row.runId === child.id &&
                  row.targetId === target.id &&
                  row.kind === "web_page",
              );
              expect(retainedPages.length).toBeGreaterThan(0);
              for (const retained of retainedPages) {
                const object = await objects.bucket.get(retained.objectKey);
                expect(object).not.toBeNull();
                const bytes = await object!.arrayBuffer();
                expect(await sha256Hex(bytes)).toBe(retained.checksum);
                expect(new TextDecoder().decode(bytes)).toBe(mailEvalPage.html);
                expect(retained.sourceMetadata).toMatchObject({
                  servedURL: mailEvalPage.url,
                  researchUploadState: "uploaded",
                });
              }
              const httpDetail = await fetch(
                `${runtime.origin}/api/v1/products/${savedProduct.shortcode}`,
                { headers },
              );
              const detailBody = await httpDetail.text();
              observations.productHTTP = {
                status: httpDetail.status,
                body: detailBody,
              };
              expect(httpDetail.status).toBe(200);
              const detail = toWire(productWithFoodOut, "output").parse(
                JSON.parse(detailBody),
              );
              expect(detail).toMatchObject({
                manufacturer: "Example Works",
                model: "P-20-SB",
                coverImageUrl: null,
              });
              const explanations = [];
              for (const field of ["manufacturer", "model", "categoryId"]) {
                const response = await fetch(
                  `${runtime.origin}/api/v1/fieldExplanation/explain?entityKind=product&entityId=${savedProduct.shortcode}&field=${field}&surface=detail`,
                  { headers },
                );
                const body = await response.text();
                explanations.push({ field, status: response.status, body });
                observations.explanations = explanations;
                expect(response.status).toBe(200);
                const explanation = toWire(
                  fieldExplanationOutput,
                  "output",
                ).parse(JSON.parse(body));
                expect(
                  explanation.verifications.some(
                    (proof) =>
                      proof.run.entityId === child.shortcode &&
                      proof.subject.entityId === savedProduct.shortcode &&
                      proof.value ===
                        (field === "model"
                          ? "P-20-SB"
                          : field === "categoryId"
                            ? category.shortcode
                            : "Example Works") &&
                      proof.support !== null,
                  ),
                ).toBe(true);
              }
              expect(
                await database.select().from(financialTransaction),
              ).toEqual(baseline.transactions);
              expect(
                await database.select().from(financialTransactionAllocation),
              ).toEqual(baseline.allocations);
              expect(await database.select().from(inventoryEntry)).toEqual(
                baseline.stock,
              );
              const usages = await Promise.all(
                [researcher, assessor].map(async (worker) =>
                  evalUsageReport.parse(
                    await (
                      await worker.fetch("https://eval.test/usage")
                    ).json(),
                  ),
                ),
              );
              const budgets = await readBudgets();
              observations.usages = usages;
              observations.budgets = budgets;
              expect(usages[1]!.requests).toBeGreaterThanOrEqual(3);
              for (const [index, usage] of usages.entries()) {
                expect(usage.requests).toBeGreaterThan(0);
                expect(usage.failedRequests).toBe(0);
                expect(usage.transport).toBe("chatgpt");
                expect(budgets[index]!.refusedRequests).toBe(0);
                expect(usage.calls).toHaveLength(usage.requests);
              }
              expect(
                budgets.reduce((sum, budget) => sum + budget.requests, 0),
              ).toBeLessThanOrEqual(aggregate.requests);
              expect(
                budgets.reduce((sum, budget) => sum + budget.reservedTokens, 0),
              ).toBeLessThanOrEqual(aggregate.tokens);
            } finally {
              observations.providerRequests = runtime.googleProvider.requests();
              observations.exitState = await snapshot(ctx.db);
              const diagnosticRuns = (
                await database
                  .select()
                  .from(run)
                  .where(eq(run.ledgerPartyId, party.id))
              ).filter((row) =>
                ["mail_import", "product_enrichment"].includes(row.purpose),
              );
              const results = await Promise.allSettled([
                ...[researcher, assessor].flatMap((worker) =>
                  ["usage", "budget"].map(async (kind) =>
                    (await worker.fetch(`https://eval.test/${kind}`)).json(),
                  ),
                ),
                assessor
                  .fetch("https://eval.test/triage-calls")
                  .then((response) => response.json()),
                ...diagnosticRuns.map((row) =>
                  workerdDiagnostic(ctx.db, row.id, runtime.harness),
                ),
              ]);
              observations.exitDiagnostics = results.map((result) =>
                diagnostic.parse(
                  result.status === "fulfilled"
                    ? {
                        status: result.status,
                        value: JSON.parse(JSON.stringify(result.value)),
                      }
                    : {
                        status: result.status,
                        error: scrubErrorMessage(String(result.reason)),
                      },
                ),
              );
              writeReport();
            }
          },
        );
        report.status = "passed";
        report.phase = "complete";
      } catch (error) {
        observations.failure = scrubErrorMessage(
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      } finally {
        const cleanup = await Promise.allSettled([
          subscription?.close(),
          storage?.close(),
        ]);
        const cleanupErrors = cleanup.flatMap((result) =>
          result.status === "rejected"
            ? [scrubErrorMessage(String(result.reason))]
            : [],
        );
        observations.cleanupErrors = cleanupErrors;
        if (cleanupErrors.length) report.status = "failed";
        writeReport();
        writeE2ERunBundle({
          repoRoot,
          outputDir: outDir,
          evidence: [reportPath],
          kind: "browser",
          status: String(report.status),
          phase: String(report.phase),
          command: [
            "env",
            `AGENT_EVAL_CANDIDATES=${candidate.model}:${candidate.effort}`,
            `AGENT_EVAL_MAX_REQUESTS=${aggregate.requests}`,
            `AGENT_EVAL_MAX_TOKENS=${aggregate.tokens}`,
            "pnpm",
            "--dir",
            "apps/web",
            "eval:purchase-mail",
          ],
          profile: "gmail-research",
          scenario: "synthetic-real-mail-and-automatic-product",
          started,
          cases: [
            {
              name: "confirmation-shipment-automatic-product",
              status: String(report.status),
              durationMs: Date.now() - begin,
            },
          ],
        });
      }
      expect(observations.cleanupErrors).toEqual([]);
    },
    caseWallMs + 120_000,
  );
});
