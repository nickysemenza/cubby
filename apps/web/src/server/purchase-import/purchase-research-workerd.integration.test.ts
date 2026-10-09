import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  executionAuthorizationInput,
  executionAuthorizationReceipt,
} from "@cubby/schemas/execution-authorization";
import { fieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { runEntityId } from "@cubby/schemas/identifiers";
import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import {
  MAILBOX_RESEARCH_VERSION,
  mailboxDiscoveryInput,
} from "@cubby/schemas/mailbox-research";
import { productWithFoodOut } from "@cubby/schemas/product";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import {
  mailResearchRunInput,
  productResearchRunInput,
} from "@cubby/schemas/run-fields";
import { requestUrl } from "@cubby/shared/ai/gateway-request";
import {
  createAiModelPricing,
  quoteAiDecisionRequest,
} from "@cubby/shared/ai/pricing";
import { sha256Hex } from "@cubby/shared/sha256";
import { makeSignature } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import {
  captureE2ERunIdentity,
  writeE2ERunBundle,
  type E2ERunIdentity,
} from "tooling/e2e-run-bundle";
import { createE2EObjectStorage } from "tooling/local-object-storage";
import { taxonomyId } from "tooling/product-category-fixtures";
import { from, type ScriptStep } from "tooling/purchase-agent-script";
import { scenarioControls } from "tooling/purchase-agent-workerd-harness";
import { withTestDb } from "tooling/test-setup";
import { readWebBuildProvenance } from "tooling/web-build-provenance";
import {
  holdWorkerdHarness,
  HOLD_WORKERD_HARNESS_TIMEOUT_MS,
} from "tooling/workerd-harness";
import {
  withWorkerdRuntime,
  type WorkerdRuntime,
} from "tooling/workerd-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import { GMAIL_READONLY_SCOPE } from "~/lib/google-auth-constants";
import { toWire } from "~/lib/http-api/wire";
import { account as googleAccount } from "~/server/db/auth.schema";
import {
  entityAttachment,
  entityExternalId,
  expense,
  financialTransactionAllocation,
  image,
  importSourceOrder,
  importSourceProduct,
  inventoryEntry,
  mailboxMessage,
  mailboxCursor,
  orderMail,
  product,
  purchase,
  researchRetention,
  run as runTable,
  runEvidence,
  runFactEvidence,
  runOperation,
  runTarget,
  session,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { createImageFixture } from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { issueExecutionAuthorization } from "~/server/runs/execution-authorization";

import { completedCapture, renderPage } from "./browser.fixtures";
import {
  authorizePurchaseAgent,
  authorizeSyntheticBackfill,
  waitFor,
  workerdDiagnostic,
} from "./purchase-agent-workerd.fixtures";
import { publishPendingResearchRetention } from "./research-retention-delivery";
import { startMailResearch } from "./research-run";

// One built-Worker boundary covers source loss, skipped automatic enrichment,
// stale browser IDs, sibling-variant writes, unretained image bytes, whole-array
// proof, private references in HTTP, and duplicate delivery creating spend.
// Provider pagination must not drop archived originals or retain unrelated
// content; real background/Workflow/queue handoffs must admit research without
// manually seeded mail. Duplicate IDs must not duplicate spend or research.
// Only external Google/model decisions and the Mac capture are synthetic peers; this
// does not measure researcher or semantic-assessor performance.
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
import {
  pageURL,
  assetKey,
  assetURL,
  orderedTitle,
  sourceText,
  png,
  page,
  mailSteps,
  productSteps,
  support,
  step,
} from "./purchase-research-journey.fixtures";

function verifyQueuedMaintenance(status: number, body: string) {
  expect({ status, body }).toMatchObject({ status: 200 });
  expect(
    z.object({ status: z.literal("queued") }).parse(JSON.parse(body)),
  ).toEqual({ status: "queued" });
}

describe("purchase research through the built Worker", () => {
  const ctx = withTestDb();
  let release: (() => void) | undefined;
  beforeAll(async () => {
    release = await holdWorkerdHarness();
  }, HOLD_WORKERD_HARNESS_TIMEOUT_MS);
  afterAll(() => release?.());

  async function verifyProviderAcquisition(input: {
    runtime: WorkerdRuntime;
    partyId: typeof mailboxCursor.$inferSelect.ledgerPartyId;
    mailboxId: string;
    approval:
      | Awaited<ReturnType<typeof issueExecutionAuthorization>>
      | undefined;
    continuousApproval:
      | Awaited<ReturnType<typeof issueExecutionAuthorization>>
      | undefined;
    importRun: typeof runTable.$inferSelect | undefined;
    child: typeof runTable.$inferSelect;
    evidence: object[];
  }) {
    const {
      runtime,
      partyId,
      mailboxId,
      approval,
      continuousApproval,
      importRun,
      child,
      evidence,
    } = input;
    const database = getDb(ctx.db);
    if (
      !runtime.googleProvider ||
      !approval ||
      !continuousApproval ||
      !importRun?.parentRunId
    )
      throw new Error("Provider authority or retained Run missing.");
    await waitFor(
      async () => {
        const [cursor] = await database
          .select()
          .from(mailboxCursor)
          .where(
            and(
              eq(mailboxCursor.ledgerPartyId, partyId),
              eq(mailboxCursor.mailboxId, mailboxId),
            ),
          );
        const [discovery] = await database
          .select()
          .from(runTable)
          .where(eq(runTable.id, importRun.parentRunId!));
        return (
          cursor?.coverage?.broad.completed === true &&
          discovery?.status === "completed"
        );
      },
      "Gmail Workflow did not checkpoint complete broad pagination.",
      30_000,
    );
    const [discovery] = await database
      .select()
      .from(runTable)
      .where(eq(runTable.id, importRun.parentRunId));
    if (!discovery) throw new Error("Actual discovery Workflow Run missing.");
    expect(
      mailboxDiscoveryInput.parse(discovery.input).executionAuthorization,
    ).toEqual(approval);
    expect(
      mailResearchRunInput.parse(importRun.input).executionAuthorization,
    ).toEqual(approval);
    expect(
      productResearchRunInput.parse(child.input).executionAuthorization,
    ).toEqual(approval);
    expect(importRun.parentRunId).toBe(discovery.id);
    const retained = await database.select().from(orderMail);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      mailboxId,
      messageId: "synthetic-confirmation",
      vendorId: null,
      content: { bodyText: sourceText },
    });
    const ledger = await database
      .select()
      .from(mailboxMessage)
      .where(eq(mailboxMessage.mailboxId, mailboxId));
    expect(ledger).toHaveLength(2);
    expect(
      ledger.find((message) => message.messageId === "synthetic-unrelated"),
    ).toMatchObject({
      classification: "unrelated",
      status: "completed",
      orderMailId: null,
      runId: null,
    });
    expect(
      ledger.find((message) => message.messageId === "synthetic-confirmation"),
    ).toMatchObject({
      classification: "related",
      status: "completed",
      orderMailId: retained[0]!.id,
      checksum: retained[0]!.rawChecksum,
      runId: importRun.id,
    });
    const originals = await database.select().from(importSourceOrder);
    expect(originals).toHaveLength(1);
    expect(originals[0]?.originalOrder?.checksum).toBe(
      retained[0]!.rawChecksum,
    );
    await waitFor(
      async () =>
        runtime
          .googleProvider!.requests()
          .some(
            (request) =>
              request.path.endsWith("/history") &&
              request.query.startHistoryId === "100",
          ),
      "Separately authorized continuous discovery did not reach the saved history baseline.",
    );
    const [historyRun] = await database
      .select()
      .from(runTable)
      .where(eq(runTable.clientKey, `mailbox-continuation:${discovery.id}`));
    expect(
      mailboxDiscoveryInput.parse(historyRun?.input).executionAuthorization,
    ).toEqual(continuousApproval);
    const requests = runtime.googleProvider.requests();
    const baselineIndex = requests.findIndex((request) =>
      request.path.endsWith("/profile"),
    );
    const firstListIndex = requests.findIndex((request) =>
      request.path.endsWith("/messages"),
    );
    expect(baselineIndex).toBeGreaterThanOrEqual(0);
    expect(firstListIndex).toBeGreaterThan(baselineIndex);
    expect(
      requests
        .filter(
          (request) =>
            request.path.endsWith("/messages") &&
            request.query.q === "-in:spam -in:trash",
        )
        .map((request) => request.query.pageToken ?? null),
    ).toEqual([null, "synthetic-page-1"]);
    expect(
      requests.filter((request) =>
        request.path.endsWith("/messages/synthetic-unrelated"),
      ),
    ).toHaveLength(2);
    expect(
      requests.filter((request) =>
        request.path.endsWith("/messages/synthetic-confirmation"),
      ),
    ).toHaveLength(1);
    expect(
      requests.some(
        (request) =>
          request.path.endsWith("/history") &&
          request.query.startHistoryId === "100",
      ),
    ).toBe(true);
    const calls = z
      .array(
        z.object({
          feature: z.string(),
          matched: z.string().nullable(),
          model: z.string().optional(),
        }),
      )
      .parse(
        await (
          await runtime.harness
            .getWorker("cubby-test-gateway")
            .fetch("https://gateway.test/calls")
        ).json(),
      );
    expect(
      calls
        .filter((call) => call.feature === "mailbox-triage")
        .map((call) => ({
          model: call.model,
          classification: call.matched,
        })),
    ).toEqual([
      { model: "typesafe/jev", classification: "unrelated" },
      { model: "typesafe/jev", classification: "related" },
    ]);
    const receipts = await database
      .select({ result: runOperation.result })
      .from(runOperation)
      .where(
        and(
          eq(runOperation.runId, approval.runId),
          eq(runOperation.kind, "execution_authorization"),
        ),
      );
    const reservations = receipts
      .map(({ result }) => executionAuthorizationReceipt.parse(result))
      .filter((receipt) => receipt.kind === "metered_reservation");
    const pricing = createAiModelPricing({
      fetch: async (input) => {
        // Catalog reads cross the host/workerd boundary as URL and body bytes.
        const response = await runtime.harness
          .getWorker("cubby-test-gateway")
          .fetch(requestUrl(input));
        return new Response(await response.text(), {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers],
        });
      },
      onError: (error) => {
        throw error;
      },
    });
    const triageQuote = quoteAiDecisionRequest(await pricing.current(), {
      provider: "typesafe",
      model: "typesafe/jev",
      questionCount: 1,
    });
    if (!triageQuote)
      throw new Error("Synthetic triage reservation is unpriced");
    // This root also funds coordinator and semantic assessment requests.
    expect(
      reservations.filter(
        (receipt) =>
          receipt.reservedMicroUSD ===
          Math.ceil(triageQuote.maxCostUsd * 1_000_000),
      ),
    ).toHaveLength(2);
    expect(
      new Set(reservations.map((receipt) => receipt.physicalAttemptId)).size,
    ).toBe(reservations.length);
    expect(reservations.every((receipt) => receipt.reservedMicroUSD > 0)).toBe(
      true,
    );
    expect(
      await database
        .select()
        .from(runTable)
        .where(eq(runTable.purpose, "mail_import")),
    ).toHaveLength(1);
    evidence.push({
      acquisition: {
        requests,
        decisions: calls.filter((call) => call.feature === "mailbox-triage"),
        retainedOriginalCount: retained.length,
        messageStatuses: ledger.map(
          ({ messageId, classification, status }) => ({
            messageId,
            classification,
            status,
          }),
        ),
        approvalFingerprint: approval.approvalFingerprint,
      },
    });
  }

  it.each([
    {
      mode: "retained",
      name: "continues an early final answer to import retained mail, automatically research its exact variant, and expose current proof while preserving recorded money",
    },
    {
      mode: "provider",
      name: "discovers paginated archived Gmail through Jev and real queues, preserves unrelated privacy, and automatically researches the supported Product",
    },
  ] as const)(
    "$name",
    async ({ mode, name }) => {
      const started = captureE2ERunIdentity(repoRoot);
      const database = getDb(ctx.db);
      const party = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic research member",
        kind: "member",
        userId: ctx.actor.userId,
      });
      const vendor = await insertWithShortcode(ctx.db, "vendor", {
        name: "Example Works",
        website: "https://maker.example.test",
        browserDomains: ["maker.example.test"],
      });
      const account = await insertWithShortcode(ctx.db, "vendorAccount", {
        label: "Synthetic browser transport",
        vendorId: vendor.id,
        ledgerPartyId: party.id,
        browserSyncEnabled: true,
      });
      await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
      const mailboxId =
        mode === "provider" ? "synthetic-google-user" : "synthetic-mailbox";
      let retainedMailId: string | undefined;
      let continuousApproval:
        | Awaited<ReturnType<typeof issueExecutionAuthorization>>
        | undefined;
      let approval:
        | Awaited<ReturnType<typeof issueExecutionAuthorization>>
        | undefined;
      if (mode === "retained") {
        const [mail] = await database
          .insert(orderMail)
          .values({
            ledgerPartyId: party.id,
            mailboxId,
            messageId: "synthetic-confirmation",
            sender: "orders@maker.example.test",
            subject: "Synthetic fan order",
            receivedAt: new Date("2026-09-14T12:00:00Z"),
            rawChecksum: await sha256Hex(sourceText),
            content: { snippet: null, bodyHtml: null, bodyText: sourceText },
          })
          .returning();
        if (!mail) throw new Error("Synthetic retained mail fixture missing.");
        await database.insert(mailboxMessage).values({
          ledgerPartyId: party.id,
          mailboxId: mail.mailboxId,
          messageId: mail.messageId,
          checksum: mail.rawChecksum,
          classification: "related",
          classificationVersion: "synthetic-positive-source-v1",
          status: "pending",
          orderMailId: mail.id,
        });
        retainedMailId = mail.id;
        approval = await authorizeSyntheticBackfill(ctx, party.id, mailboxId);
      } else {
        await database.insert(googleAccount).values({
          id: crypto.randomUUID(),
          accountId: mailboxId,
          providerId: "google",
          userId: ctx.actor.userId,
          accessToken: "synthetic-mail-access",
          refreshToken: "synthetic-mail-refresh",
          scope: GMAIL_READONLY_SCOPE,
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        });
        approval = await issueExecutionAuthorization(
          ctx.db,
          ctx.actor,
          executionAuthorizationInput.parse({
            kind: "execution_authorization",
            version: 1,
            owner: { userId: ctx.actor.userId, ledgerPartyId: party.id },
            scope: { kind: "backfill", mailboxId, discovery: "all_history" },
            meteredBudget: { period: "lifetime", limitMicroUSD: 1_000_000 },
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
        continuousApproval = await issueExecutionAuthorization(
          ctx.db,
          ctx.actor,
          executionAuthorizationInput.parse({
            kind: "execution_authorization",
            version: 1,
            owner: { userId: ctx.actor.userId, ledgerPartyId: party.id },
            scope: { kind: "continuous", mailboxId, discovery: "new_mail" },
            meteredBudget: {
              period: "utc_calendar_month",
              limitMicroUSD: 1_000_000,
            },
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
      }
      const staged = await createImageFixture(
        ctx.db,
        "synthetic-research-fan",
        {
          key: assetKey,
          source: "catalog",
          sourceAssetUrl: assetURL,
          sha256: null,
          contentType: "image/png",
          size: png.byteLength,
        },
      );
      const storage = await createE2EObjectStorage();
      const startedAt = Date.now();
      const artifactDir = path.join(
        repoRoot,
        "artifacts/purchase-research-workerd",
        `${mode}-${new Date().toISOString().replace(/[:.]/gu, "-")}`,
      );
      mkdirSync(artifactDir, { recursive: true });
      const evidence: object[] = [];
      const revision = started.source;
      let failure: string | undefined;
      let runId: string | undefined;
      let googleProvider: WorkerdRuntime["googleProvider"];
      try {
        await storage.bucket.put(assetKey, png, {
          httpMetadata: { contentType: "image/png" },
        });
        await withWorkerdRuntime(
          {
            profile: mode === "provider" ? "gmail-research" : "purchase-agent",
            database: { borrowed: ctx.databaseUrl },
            objectStorage: {
              borrowed: {
                endpoint: storage.url,
                publicUrl: "https://assets.example.test",
              },
            },
          },
          // eslint-disable-next-line complexity -- This complete journey checks each independent persistence and HTTP boundary before reporting success.
          async (runtime) => {
            googleProvider = runtime.googleProvider;
            const build = readWebBuildProvenance(repoRoot);
            expect({
              fresh: build.sourceFresh,
              reason: build.details.reason,
            }).toMatchObject({ fresh: true });
            writeFileSync(
              path.join(artifactDir, "build.json"),
              `${JSON.stringify(build, null, 2)}\n`,
            );
            const controls = scenarioControls(runtime.harness);
            const model = runtime.harness.getWorker("cubby-test-model");
            const gateway = runtime.harness.getWorker("cubby-test-gateway");
            if (mode === "provider") {
              if (!runtime.googleProvider)
                throw new Error(
                  "Gmail acquisition profile has no external provider.",
                );
              const original = {
                id: "synthetic-confirmation",
                threadId: "synthetic-fan-thread",
                historyId: "100",
                labelIds: [],
                internalDate: String(Date.parse("2026-09-14T12:00:00Z")),
                payload: {
                  mimeType: "text/plain",
                  headers: [
                    { name: "From", value: "receipts@platform.example.test" },
                    { name: "Subject", value: "Synthetic fan order" },
                  ],
                  body: {
                    data: Buffer.from(sourceText).toString("base64url"),
                    size: Buffer.byteLength(sourceText),
                  },
                },
              };
              const unrelatedText =
                "Synthetic picnic invitation with no acquisition or payment.";
              const unrelated = {
                id: "synthetic-unrelated",
                threadId: "synthetic-social-thread",
                historyId: "100",
                labelIds: [],
                internalDate: String(Date.parse("2026-09-13T12:00:00Z")),
                payload: {
                  mimeType: "text/plain",
                  headers: [
                    { name: "From", value: "friends@social.example.test" },
                    { name: "Subject", value: "Synthetic picnic invitation" },
                  ],
                  body: {
                    data: Buffer.from(unrelatedText).toString("base64url"),
                    size: Buffer.byteLength(unrelatedText),
                  },
                },
              };
              runtime.googleProvider.configure({
                email: "synthetic-researcher@example.test",
                message: original,
                classification: { events: [] },
                mailbox: {
                  historyId: "100",
                  messages: [unrelated, original],
                  pages: [[unrelated.id], [unrelated.id, original.id]],
                  history: [],
                },
              });
            }
            const post = async (
              worker: typeof model,
              url: string,
              body: string,
            ) => {
              const response = await worker.fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
              });
              expect({
                ok: response.ok,
                body: await response.text(),
              }).toMatchObject({ ok: true });
            };
            await post(
              model,
              "https://model.test/configure",
              JSON.stringify({
                steps:
                  mode === "retained"
                    ? [
                        {
                          await: ["cubby.research-continuation"],
                          text: "The coordinator ended before investigating its assigned mail.",
                        },
                        ...mailSteps,
                      ]
                    : mailSteps,
                purposeSteps: { product_enrichment: productSteps },
              }),
            );
            await post(
              gateway,
              "https://gateway.test/configure",
              JSON.stringify({
                extractions: [],
                decisions:
                  mode === "provider"
                    ? [
                        {
                          feature: "mailbox-triage",
                          match: "Synthetic picnic invitation",
                          label: "unrelated",
                        },
                        {
                          feature: "mailbox-triage",
                          match: "SYNTHETIC-410",
                          label: "related",
                        },
                      ]
                    : [],
                assessments: [
                  {
                    match: "SYNTHETIC-410 has one item",
                    output: {
                      identityVerified: true,
                      acceptedFacts: [],
                      acceptedIdentifiers: [],
                      acceptedIdentifierClaims: [],
                      acceptedImages: [],
                      acceptedOrders: [0],
                      acceptedEmailLinks: [],
                      rejected: [],
                    },
                  },
                  {
                    match: "F17SB",
                    output: {
                      identityVerified: true,
                      acceptedFacts: [0, 1, 2],
                      acceptedIdentifiers: [],
                      acceptedIdentifierClaims: [0],
                      acceptedImages: [0],
                      acceptedOrders: [],
                      acceptedEmailLinks: [],
                      rejected: [],
                    },
                  },
                ],
              }),
            );
            await controls.connectBrowser({
              vendorAccountId: account.id,
              ledgerPartyId: party.id,
              userId: ctx.actor.userId,
              outcomes: { [pageURL]: await completedCapture(pageURL, page) },
            });
            const deliveries: PurchaseAgentEvent[] = [];
            if (mode === "retained") {
              if (!retainedMailId)
                throw new Error("Retained source identity missing.");
              const admitted = await startMailResearch(
                ctx.db,
                {
                  ledgerPartyId: party.id,
                  userId: ctx.actor.userId,
                  mailboxId,
                  messageIds: [retainedMailId],
                },
                {
                  send: async (event) => {
                    deliveries.push(event);
                  },
                },
              );
              runId = admitted[0]?.runId;
              if (!runId || !deliveries[0])
                throw new Error("Synthetic mail was not admitted and queued.");
              const replayDelivery = deliveries[0];
              if (!replayDelivery)
                throw new Error("Mail dispatch identity missing.");
              await controls.dispatch(replayDelivery);
            } else {
              const token = `synthetic-discovery-http-${crypto.randomUUID()}`;
              const now = new Date();
              await database.insert(session).values({
                id: crypto.randomUUID(),
                token,
                userId: ctx.actor.userId,
                expiresAt: new Date(now.getTime() + 300_000),
                createdAt: now,
                updatedAt: now,
              });
              const signature = await makeSignature(
                token,
                process.env.BETTER_AUTH_SECRET || "e2e-test-secret",
              );
              const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
              const response = await fetch(
                `${runtime.origin}/api/v1/maintenance/requestCatchUp`,
                {
                  method: "POST",
                  headers: {
                    cookie,
                    origin: runtime.origin,
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({}),
                },
              );
              const body = await response.text();
              evidence.push({
                http: "maintenance.requestCatchUp",
                status: response.status,
                body,
              });
              verifyQueuedMaintenance(response.status, body);
              await waitFor(
                async () => {
                  const [mailRun] = await database
                    .select()
                    .from(runTable)
                    .where(
                      and(
                        eq(runTable.purpose, "mail_import"),
                        eq(runTable.ledgerPartyId, party.id),
                      ),
                    );
                  if (!mailRun) return false;
                  runId = mailRun.id;
                  return true;
                },
                "Provider acquisition did not automatically enqueue mail research.",
                30_000,
              ).catch(async (error: UnparsedError) => {
                evidence.push({
                  acquisitionFailure: scrubErrorMessage(
                    error instanceof Error ? error.message : String(error),
                  ),
                });
                try {
                  const discoveryRuns = await database
                    .select({ id: runTable.id })
                    .from(runTable)
                    .where(
                      and(
                        eq(runTable.purpose, "mail_discovery"),
                        eq(runTable.ledgerPartyId, party.id),
                      ),
                    );
                  evidence.push({
                    gateway: await controls.gatewayCalls(),
                    discovery: await Promise.all(
                      discoveryRuns.map(({ id }) =>
                        workerdDiagnostic(ctx.db, id, runtime.harness),
                      ),
                    ),
                  });
                } catch (diagnosticError) {
                  evidence.push({
                    acquisitionDiagnosticFailure: scrubErrorMessage(
                      diagnosticError instanceof Error
                        ? diagnosticError.message
                        : String(diagnosticError),
                    ),
                  });
                }
                throw new Error(
                  `${error instanceof Error ? error.message : String(error)}\nAcquisition diagnostics: ${JSON.stringify(evidence.slice(-2))}`,
                  { cause: error },
                );
              });
              const [mailRun] = await database
                .select()
                .from(runTable)
                .where(eq(runTable.id, runEntityId.parse(runId!)));
              if (!mailRun?.dispatchEventId)
                throw new Error(
                  "Automatic mail queue delivery identity missing.",
                );
              deliveries.push({
                version: 1,
                type: "start_or_resume",
                runId: mailRun.id,
                purpose: "mail_import",
                eventId: mailRun.dispatchEventId,
              });
            }
            try {
              await waitFor(
                async () => {
                  const rows = await database
                    .select()
                    .from(runTable)
                    .where(
                      and(
                        eq(runTable.parentRunId, runEntityId.parse(runId!)),
                        eq(runTable.purpose, "product_enrichment"),
                      ),
                    );
                  const [parent] = await database
                    .select({ status: runTable.status })
                    .from(runTable)
                    .where(eq(runTable.id, runEntityId.parse(runId!)));
                  if (
                    parent?.status === "failed" ||
                    parent?.status === "needs_review" ||
                    rows.some(
                      (row) =>
                        row.status === "failed" ||
                        row.status === "needs_review",
                    )
                  )
                    throw new Error(
                      "Research settled without the supported complete import and Product proof.",
                    );
                  return rows.some((row) => row.status === "completed");
                },
                "Automatic Product research did not complete from the retained mail import.",
                40_000,
              );
              const [importRun] = await database
                .select()
                .from(runTable)
                .where(eq(runTable.id, runEntityId.parse(runId)));
              const [child] = await database
                .select()
                .from(runTable)
                .where(
                  and(
                    eq(runTable.parentRunId, runEntityId.parse(runId)),
                    eq(runTable.purpose, "product_enrichment"),
                  ),
                );
              if (!child) throw new Error("Automatic child Run missing.");
              expect(importRun?.status).toBe("completed");
              const continuations = await database
                .select({ state: runOperation.state })
                .from(runOperation)
                .where(
                  and(
                    eq(runOperation.runId, runEntityId.parse(runId)),
                    eq(runOperation.kind, "research_continue"),
                  ),
                );
              expect(continuations).toEqual(
                mode === "retained" ? [{ state: "completed" }] : [],
              );
              evidence.push({
                consumedHostContinuations: continuations.length,
              });
              if (mode === "provider")
                await verifyProviderAcquisition({
                  runtime,
                  partyId: party.id,
                  mailboxId,
                  approval,
                  continuousApproval,
                  importRun,
                  child,
                  evidence,
                });
              expect(child).toMatchObject({
                cause: "import_completed",
                attempt: 1,
                vendorAccountId: null,
                predecessorRunId: null,
              });
              const [target] = await database
                .select()
                .from(runTarget)
                .where(eq(runTarget.runId, child.id));
              expect(target).toMatchObject({
                entityKind: "product",
                outcome: "verified",
              });
              const [line] = await database.select().from(expense);
              if (!line?.productId || !line.purchaseId)
                throw new Error(
                  "Itemized original did not create its Product and Expense.",
                );
              const [savedProduct] = await database
                .select()
                .from(product)
                .where(eq(product.id, line.productId));
              const [savedPurchase] = await database
                .select()
                .from(purchase)
                .where(eq(purchase.id, line.purchaseId));
              if (!savedProduct || !savedPurchase)
                throw new Error("Imported business records missing.");
              expect(savedProduct).toMatchObject({
                manufacturer: "Example Works",
                model: "F17SB",
                categoryId: taxonomyId("electronics"),
              });
              expect(savedPurchase).toMatchObject({
                date: "2026-09-14",
                statedTotal: 24,
              });
              expect(line).toMatchObject({ cost: 24, productQuantity: 1 });
              expect(await database.select().from(inventoryEntry)).toEqual([]);
              expect(
                await database.select().from(financialTransactionAllocation),
              ).toEqual([]);
              const sourceOrders = await database
                .select()
                .from(importSourceOrder);
              expect(sourceOrders).toHaveLength(1);
              expect(sourceOrders[0]?.originalOrder).toMatchObject({
                extraction: { candidate: { lines: [{ title: orderedTitle }] } },
              });
              expect(
                await database.select().from(importSourceProduct),
              ).toMatchObject([
                {
                  sourceOrderId: sourceOrders[0]?.id,
                  lineIndex: 0,
                  productId: savedProduct.id,
                },
              ]);
              const identifiers = await database
                .select()
                .from(entityExternalId)
                .where(eq(entityExternalId.entityId, savedProduct.id));
              expect(identifiers).toMatchObject([
                { kind: "manufacturer_part", externalId: "FAN-SM-BL" },
              ]);
              const attachments = await database
                .select()
                .from(entityAttachment)
                .where(eq(entityAttachment.entityId, savedProduct.id));
              expect(attachments).toHaveLength(1);
              expect(attachments[0]?.imageId).toBe(staged.id);
              const [savedImage] = await database
                .select()
                .from(image)
                .where(eq(image.id, staged.id));
              expect(savedImage?.sha256).toBe(await sha256Hex(png));
              const object = await storage.bucket.get(assetKey);
              expect(object).not.toBeNull();
              expect(await sha256Hex(await object!.arrayBuffer())).toBe(
                savedImage?.sha256,
              );
              const proofs = await database
                .select()
                .from(runFactEvidence)
                .where(eq(runFactEvidence.targetId, target!.id));
              expect(proofs.map((row) => row.fieldPath).sort()).toEqual(
                [
                  "categoryId",
                  "manufacturer",
                  "model",
                  `externalIds.i${identifiers[0]!.id.replaceAll("-", "")}`,
                  `images.i${attachments[0]!.id.replaceAll("-", "")}`,
                ].sort(),
              );
              const captures = await database
                .select()
                .from(runEvidence)
                .where(eq(runEvidence.runId, child.id));
              expect(
                captures.some(
                  (row) =>
                    row.kind === "browser_capture" &&
                    row.targetId === target!.id &&
                    row.checksum.length === 64,
                ),
              ).toBe(true);
              for (const capture of captures.filter(
                (row) => row.kind === "browser_capture",
              )) {
                const retained = await storage.bucket.get(capture.objectKey);
                expect(retained).not.toBeNull();
                const retainedBytes = await retained!.arrayBuffer();
                expect(await sha256Hex(retainedBytes)).toBe(capture.checksum);
                expect(new TextDecoder().decode(retainedBytes)).toBe(
                  renderPage(page),
                );
              }
              const token = `synthetic-http-${crypto.randomUUID()}`;
              const now = new Date();
              await database.insert(session).values({
                id: crypto.randomUUID(),
                token,
                userId: ctx.actor.userId,
                expiresAt: new Date(now.getTime() + 60_000),
                createdAt: now,
                updatedAt: now,
              });
              const signature = await makeSignature(
                token,
                process.env.BETTER_AUTH_SECRET || "e2e-test-secret",
              );
              const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
              const headers = { cookie };
              const detailResponse = await fetch(
                `${runtime.origin}/api/v1/products/${savedProduct.shortcode}`,
                { headers },
              );
              const detailBody = await detailResponse.text();
              evidence.push({
                http: "product-detail",
                status: detailResponse.status,
                body: detailBody,
              });
              expect(detailResponse.status).toBe(200);
              const detail = toWire(productWithFoodOut, "output").parse(
                JSON.parse(detailBody),
              );
              expect(detail).toMatchObject({
                manufacturer: "Example Works",
                model: "F17SB",
              });
              expect(detail.coverImageUrl).toContain(assetKey);
              const fields = [
                "manufacturer",
                "model",
                "categoryId",
                "externalIds",
                "images",
              ];
              const explanations = await Promise.all(
                fields.map(async (field) => {
                  const response = await fetch(
                    `${runtime.origin}/api/v1/fieldExplanation/explain?entityKind=product&entityId=${savedProduct.shortcode}&field=${field}&surface=detail`,
                    { headers },
                  );
                  return {
                    field,
                    status: response.status,
                    body: await response.text(),
                  };
                }),
              );
              evidence.push(
                ...explanations.map((response) => ({
                  http: "field-explanation",
                  ...response,
                })),
              );
              for (const { field, status, body } of explanations) {
                expect({ field, status }).toMatchObject({
                  status: 200,
                });
                const explanation = toWire(
                  fieldExplanationOutput,
                  "output",
                ).parse(JSON.parse(body));
                expect(explanation.verifications).toHaveLength(1);
                const proof = explanation.verifications[0]!;
                expect(proof).toMatchObject({
                  run: { entityKind: "run", entityId: child.shortcode },
                  subject: {
                    entityKind: "product",
                    entityId: savedProduct.shortcode,
                  },
                  support: {
                    reasoning: support.reasoning,
                    selectedVariant: support.selectedVariant,
                  },
                  supportRetiredAt: null,
                  source: { url: pageURL },
                });
                expect(proof.verifiedAt).toMatch(/^\d{4}-/u);
                expect(proof.source.label.length).toBeGreaterThan(0);
                const pathPattern =
                  field === "externalIds" || field === "images"
                    ? `^${field}\\.i[0-9a-f]{32}$`
                    : `^${field}$`;
                expect(proof.fieldPath).toMatch(new RegExp(pathPattern, "u"));
                expect(Array.isArray(proof.value)).toBe(false);
                evidence.push({ field, explanation });
              }
              const beforeReplay = {
                purchases: await database.select().from(purchase),
                expenses: await database.select().from(expense),
                proofs,
                attachments,
                identifiers,
              };
              const replayDelivery = deliveries[0];
              if (!replayDelivery)
                throw new Error("Mail dispatch identity missing.");
              await controls.dispatch(replayDelivery);
              if (!child.dispatchEventId)
                throw new Error("Child dispatch identity missing.");
              await controls.dispatch({
                version: 1,
                type: "start_or_resume",
                runId: child.id,
                purpose: "product_enrichment",
                eventId: child.dispatchEventId,
              });
              expect({
                purchases: await database.select().from(purchase),
                expenses: await database.select().from(expense),
                proofs: await database
                  .select()
                  .from(runFactEvidence)
                  .where(eq(runFactEvidence.targetId, target!.id)),
                attachments: await database
                  .select()
                  .from(entityAttachment)
                  .where(eq(entityAttachment.entityId, savedProduct.id)),
                identifiers: await database
                  .select()
                  .from(entityExternalId)
                  .where(eq(entityExternalId.entityId, savedProduct.id)),
              }).toEqual(beforeReplay);
              expect(await controls.violations()).toEqual([]);
              expect(await controls.emitted()).toEqual(
                expect.arrayContaining([
                  ...(mode === "retained"
                    ? ["await:cubby.research-continuation"]
                    : []),
                  "mail-resolve",
                  "product-observe",
                  "product-resolve",
                ]),
              );
              evidence.push({
                imported: {
                  purchase: savedPurchase.shortcode,
                  product: savedProduct.shortcode,
                  cost: line.cost,
                  date: savedPurchase.date,
                },
                runs: {
                  parent: importRun?.shortcode,
                  child: child.shortcode,
                  cause: child.cause,
                },
                imageSha256: savedImage?.sha256,
                retainedCaptureChecksums: captures.map((row) => row.checksum),
                emitted: await controls.emitted(),
                gateway: await controls.gatewayCalls(),
                duplicateQueueAcknowledgement:
                  "enqueued; consumption not acknowledged by this peer",
                replaySnapshots: "unchanged after enqueue",
              });
            } catch (error) {
              if (!runId) {
                evidence.push({
                  diagnosticError: "Mail Run was not admitted.",
                  emitted: await controls.emitted(),
                  violations: await controls.violations(),
                });
                throw error;
              }
              const children = await database
                .select({ id: runTable.id })
                .from(runTable)
                .where(eq(runTable.parentRunId, runEntityId.parse(runId)));
              evidence.push({
                emitted: await controls.emitted(),
                violations: await controls.violations(),
                gateway: await controls.gatewayCalls(),
                diagnostic: await workerdDiagnostic(
                  ctx.db,
                  runId,
                  runtime.harness,
                ),
                children: await Promise.all(
                  children.map((child) =>
                    workerdDiagnostic(ctx.db, child.id, runtime.harness),
                  ),
                ),
              });
              throw error;
            }
          },
        );
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        await storage.close();
        if (googleProvider)
          evidence.push({ providerRequests: googleProvider.requests() });
        writeFileSync(
          path.join(artifactDir, "report.json"),
          `${JSON.stringify({ synthetic: true, revision, replayCommand: `pnpm --dir apps/web test:postgres src/server/purchase-import/purchase-research-workerd.integration.test.ts --project integration-workerd -t '${name}'`, result: failure ? "failed" : "passed", failure, durationMs: Date.now() - startedAt, evidence, limits: ["Scripted external model decisions; no real-model judgment evaluated", "Declared-bucket stored asset reuse; remote HTTP image download not exercised", "HTTP read models only; no visual browser or native rendering assertion", "Duplicate queue sends acknowledge enqueue only; consumer acknowledgement is not asserted here (terminal replay fences retain focused integration coverage)"] }, null, 2)}\n`,
        );
        writeE2ERunBundle({
          repoRoot,
          outputDir: artifactDir,
          evidence: [artifactDir],
          kind: "browser",
          status: failure ? "failed" : "passed",
          started,
          command: [
            "pnpm",
            "--dir",
            path.join(repoRoot, "apps/web"),
            "test:postgres",
            "src/server/purchase-import/purchase-research-workerd.integration.test.ts",
            "--project",
            "integration-workerd",
            "-t",
            name,
          ],
          profile: mode === "provider" ? "gmail-research" : "purchase-agent",
          scenario: `synthetic ${mode} mail to supported Product proof`,
          phase: "completed",
          cases: [
            {
              name,
              status: failure ? "failed" : "passed",
              durationMs: Date.now() - startedAt,
            },
          ],
        });
      }
    },
    120_000,
  );
});

// A negative source must publish cleanup after commit, survive queue redelivery,
// erase retained bytes and coordinator history, and transfer only unfinished
// work. A completed receipt without a cold disposal ACK is not deletion proof.
describe("unrelated mail retention through the built Worker", () => {
  const ctx = withTestDb();
  let release: (() => void) | undefined;
  beforeAll(async () => {
    release = await holdWorkerdHarness();
  }, HOLD_WORKERD_HARNESS_TIMEOUT_MS);
  afterAll(() => release?.());

  it.each(["automatic", "recovery", "history"] as const)(
    "%s cleanup delivery retires unrelated content and continues remaining work with honest gaps",
    async (delivery) => {
      const database = getDb(ctx.db);
      const member = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic retention member",
        kind: "member",
        userId: ctx.actor.userId,
      });
      await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
      const sources: (typeof orderMail.$inferSelect)[] = [];
      for (const [name, body] of [
        [
          "newsletter",
          "Synthetic newsletter about a community picnic. No order, purchased item, payment, or shipment is described.",
        ],
        [
          "remaining",
          "Synthetic purchase inquiry: a portable fan was ordered, but the ordered variant, date, price, and quantity are unavailable.",
        ],
      ]) {
        const checksum = await sha256Hex(body!);
        const [source] = await database
          .insert(orderMail)
          .values({
            ledgerPartyId: member.id,
            mailboxId: "synthetic-retention-mailbox",
            messageId: `synthetic-retention-${name}`,
            sender: "sources@example.test",
            subject: `Synthetic ${name} source`,
            receivedAt: new Date("2026-09-15T12:00:00Z"),
            rawChecksum: checksum,
            content: { snippet: null, bodyHtml: null, bodyText: body! },
          })
          .returning();
        if (!source) throw new Error("Synthetic retention source missing.");
        sources.push(source);
        await database.insert(mailboxMessage).values({
          ledgerPartyId: member.id,
          mailboxId: source.mailboxId,
          messageId: source.messageId,
          checksum,
          classification: "related",
          classificationVersion: MAILBOX_RESEARCH_VERSION,
          status: "pending",
          orderMailId: source.id,
        });
      }
      const [newsletter, remaining] = sources;
      if (!newsletter || !remaining)
        throw new Error("Synthetic retention sources missing.");
      const commonSteps = [
        step("retention-next", "work_next"),
        step("retention-read", "mail_read", {
          workRef: from("retention-next", "work.workRef"),
          messageRef: from("retention-next", "work.sources.0.messageRef"),
        }),
      ];
      const negativeSteps: ScriptStep[] = [
        ...commonSteps,
        { gate: "retention-decision" },
        step("retention-unrelated", "work_resolve", {
          workRef: from("retention-next", "work.workRef"),
          status: "unrelated",
          identity: {
            evidenceIds: [from("retention-read", "evidenceId")],
            reasoning:
              "The retained newsletter describes a community picnic and contains no purchase or shipment information.",
          },
          detail: "The picnic newsletter is unrelated to purchase research.",
        }),
      ];
      const remainingSteps: ScriptStep[] = [
        ...commonSteps,
        step("retention-gaps", "work_resolve", {
          workRef: from("retention-next", "work.workRef"),
          status: "researched_with_gaps",
          identity: {
            evidenceIds: [from("retention-read", "evidenceId")],
            reasoning:
              "A purchase inquiry is retained, but it does not identify an exact variant or supply financial fields.",
          },
          detail:
            "The ordered variant, date, price, and quantity remain unknown. No Purchase, Product, or Expense can be supported by this source alone.",
        }),
      ];
      const storage = await createE2EObjectStorage();
      const outputDir = path.join(
        repoRoot,
        "artifacts/purchase-research-retention-workerd",
        `${delivery}-${new Date().toISOString().replace(/[:.]/gu, "-")}`,
      );
      mkdirSync(outputDir, { recursive: true });
      const observations: object[] = [];
      let started: E2ERunIdentity | undefined;
      let runId: string | undefined;
      let status = "failed";
      const began = Date.now();
      try {
        await withWorkerdRuntime(
          {
            profile: "purchase-agent",
            database: { borrowed: ctx.databaseUrl },
            objectStorage: {
              borrowed: {
                endpoint: storage.url,
                publicUrl: "https://assets.example.test",
              },
            },
          },
          async (runtime) => {
            started = captureE2ERunIdentity(repoRoot);
            expect(started.build.sourceFresh).toBe(true);
            const controls = scenarioControls(runtime.harness);
            const model = runtime.harness.getWorker("cubby-test-model");
            const gateway = runtime.harness.getWorker("cubby-test-gateway");
            const peer = runtime.harness.getWorker("cubby-queue-producer");
            const post = (
              worker: typeof model,
              pathname: string,
              body: string,
            ) =>
              worker.fetch(`https://peer.test${pathname}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
              });
            const sourceSteps = [
              {
                call: "retention-read",
                path: "observation.readableText",
                includes: "community picnic",
                steps: negativeSteps,
              },
              {
                call: "retention-read",
                path: "observation.readableText",
                includes: "Synthetic purchase inquiry",
                steps: remainingSteps,
              },
            ];
            expect(
              (
                await post(
                  model,
                  "/configure",
                  JSON.stringify({
                    steps: negativeSteps,
                    sourceSteps,
                  }),
                )
              ).status,
            ).toBe(204);
            const assessment = {
              identityVerified: false,
              acceptedFacts: [],
              acceptedIdentifiers: [],
              acceptedIdentifierClaims: [],
              acceptedImages: [],
              acceptedOrders: [],
              acceptedEmailLinks: [],
              rejected: [],
            };
            expect(
              (
                await post(
                  gateway,
                  "/configure",
                  JSON.stringify({
                    extractions: [],
                    assessments: [
                      { match: "community picnic", output: assessment },
                      {
                        match: "ordered variant, date, price, and quantity",
                        output: assessment,
                      },
                    ],
                  }),
                )
              ).status,
            ).toBe(204);
            await authorizeSyntheticBackfill(
              ctx,
              member.id,
              newsletter.mailboxId,
            );
            const events: PurchaseAgentEvent[] = [];
            const [admitted] = await startMailResearch(
              ctx.db,
              {
                ledgerPartyId: member.id,
                userId: ctx.actor.userId,
                mailboxId: newsletter.mailboxId,
                messageIds: sources.map((source) => source.id),
              },
              {
                send: async (event) => {
                  events.push(event);
                },
              },
            );
            if (!admitted) throw new Error("Synthetic retention Run missing.");
            runId = admitted.runId;
            // Fixture ordering makes the negative decision precede the untouched work.
            await database
              .update(runTarget)
              .set({ createdAt: new Date("2026-09-01T00:00:00Z") })
              .where(
                and(
                  eq(runTarget.runId, runEntityId.parse(runId)),
                  eq(runTarget.workKey, newsletter.id),
                ),
              );
            for (const event of events) await controls.dispatch(event);
            await waitFor(
              async () =>
                (await controls.emitted()).includes("gate:retention-decision"),
              "The real researcher did not read its issued source",
              5_000,
            );
            const retained = await database
              .select()
              .from(runEvidence)
              .where(eq(runEvidence.runId, runEntityId.parse(runId)));
            expect(retained.length).toBeGreaterThan(0);
            const retainedObjects = retained.filter((item) => item.objectKey);
            expect(retainedObjects.length).toBeGreaterThan(0);
            for (const item of retainedObjects) {
              const object = await storage.bucket.get(item.objectKey!);
              expect(object).not.toBeNull();
              expect(await sha256Hex(await object!.arrayBuffer())).toBe(
                item.checksum,
              );
            }
            let historicalReference: string | undefined;
            let unrelatedHistory: string | undefined;
            if (delivery === "history") {
              const history = await insertWithShortcode(ctx.db, "run", {
                ledgerPartyId: member.id,
                actorUserId: ctx.actor.userId,
                actorName: "Synthetic retention member",
                actorEmail: "retention@example.test",
                actorLedgerPartyShortcode: member.shortcode,
                actorLedgerPartyName: member.name,
                actorLedgerPartyKind: "member",
                purpose: "mail_import",
                trigger: "manual",
                status: "completed",
                deletedAt: new Date(),
              });
              historicalReference = history.id;
              const unrelated = await insertWithShortcode(ctx.db, "run", {
                ledgerPartyId: member.id,
                actorUserId: ctx.actor.userId,
                actorName: "Synthetic retention member",
                actorEmail: "retention@example.test",
                actorLedgerPartyShortcode: member.shortcode,
                actorLedgerPartyName: member.name,
                actorLedgerPartyKind: "member",
                purpose: "mail_import",
                trigger: "manual",
                status: "completed",
              });
              unrelatedHistory = unrelated.id;
              await database.insert(runOperation).values({
                runId: history.id,
                operationId: "synthetic-unregistered-source",
                kind: "synthetic_history",
                inputFingerprint: "a".repeat(64),
                state: "completed",
                result: { context: [{ original: { source: newsletter.id } }] },
              });
              // Similar-size historical JSON must not starve a current negative
              // decision. Keys and strings containing an ID are not references.
              const rows = Array.from({ length: 2000 }, (_, index) => ({
                runId: unrelated.id,
                operationId: `synthetic-history-${index}`,
                kind: "synthetic_history",
                inputFingerprint: "b".repeat(64),
                state: "completed",
                result: {
                  [newsletter.id]: "A source-looking key is not a value.",
                  archive: Array.from({ length: 40 }, (_, entry) => ({
                    sequence: index * 40 + entry,
                    reference: `prefix-${newsletter.id}-suffix`,
                    observation: {
                      title: `Synthetic history ${index} entry ${entry}`,
                      details: Array.from({ length: 24 }).reduce<object>(
                        (context) => ({ retained: context }),
                        { text: "Synthetic historical context." },
                      ),
                    },
                  })),
                },
              }));
              for (let offset = 0; offset < rows.length; offset += 100)
                await database
                  .insert(runOperation)
                  .values(rows.slice(offset, offset + 100));
              observations.push({
                boundary: "synthetic historical context",
                operations: rows.length,
                serializedBytes: rows.reduce(
                  (total, row) => total + JSON.stringify(row.result).length,
                  0,
                ),
              });
            }
            expect(
              (
                await post(
                  model,
                  "/release",
                  JSON.stringify({ gate: "retention-decision" }),
                )
              ).status,
            ).toBe(204);
            await waitFor(
              async () =>
                (
                  await database
                    .select()
                    .from(researchRetention)
                    .where(
                      eq(researchRetention.runId, runEntityId.parse(runId!)),
                    )
                ).length === 1,
              "The real unrelated decision did not retain its cleanup receipt",
              5_000,
            );
            const [receipt] = await database
              .select()
              .from(researchRetention)
              .where(eq(researchRetention.runId, runEntityId.parse(runId)));
            if (!receipt) throw new Error("Synthetic cleanup receipt missing.");
            expect(
              receipt.plan.retiredRunIds.includes(historicalReference ?? ""),
            ).toBe(delivery === "history");
            expect(
              receipt.plan.retiredRunIds.includes(unrelatedHistory ?? ""),
            ).toBe(false);
            observations.push({
              boundary: "negative decision",
              receiptId: receipt.id,
              phase: receipt.phase,
              retainedChecksums: retained.map((item) => item.checksum),
            });
            if (delivery === "recovery") {
              // This is the public pending-receipt publisher used by catch-up, not a fabricated cleanup result.
              await publishPendingResearchRetention(ctx.db, {
                receiptId: receipt.id,
                queue: {
                  send: async (event) => {
                    await controls.dispatch(event);
                  },
                },
              });
            }
            const readSuccessors = async () => {
              const successors = await database
                .select({
                  id: runTable.id,
                  shortcode: runTable.shortcode,
                  status: runTable.status,
                  endedAt: runTable.endedAt,
                  predecessorRunId: runTable.predecessorRunId,
                  parentRunId: runTable.parentRunId,
                  cause: runTable.cause,
                  attempt: runTable.attempt,
                })
                .from(runTable)
                .where(
                  eq(runTable.predecessorRunId, runEntityId.parse(runId!)),
                );
              return Promise.all(
                successors.map(async (successor) => ({
                  ...successor,
                  targets: await database
                    .select({
                      workKey: runTarget.workKey,
                      state: runTarget.state,
                      outcome: runTarget.outcome,
                    })
                    .from(runTarget)
                    .where(eq(runTarget.runId, successor.id)),
                })),
              );
            };
            try {
              await waitFor(
                async () =>
                  (
                    await database
                      .select()
                      .from(researchRetention)
                      .where(eq(researchRetention.id, receipt.id))
                  )[0]?.phase === "completed",
                `${delivery} receipt cleanup did not complete through the real Worker queue and RunServices`,
                6_000,
              );
              const [finished] = await database
                .select()
                .from(researchRetention)
                .where(eq(researchRetention.id, receipt.id));
              expect(finished?.completedAt).toBeInstanceOf(Date);
              const [retired] = await database
                .select()
                .from(runTable)
                .where(eq(runTable.id, runEntityId.parse(runId)));
              expect(retired?.retiredAt).toBeInstanceOf(Date);
              expect(retired?.retirementReason).toBe("unrelated_source");
              const agentId = importRunAgentIdentity(runId, "mail_import");
              const cold = await post(
                peer,
                "/coordinator-retire",
                JSON.stringify({
                  agentId,
                  receiptId: receipt.id,
                }),
              );
              expect(cold.status).toBe(200);
              expect(
                z.object({ disposed: z.boolean() }).parse(await cold.json()),
              ).toEqual({ disposed: true });
              expect(
                (
                  await post(
                    peer,
                    "/coordinator-fetch",
                    JSON.stringify({ agentId }),
                  )
                ).status,
              ).toBe(410);
              const fenced = await post(
                peer,
                "/coordinator-dispatch",
                JSON.stringify({
                  agentId,
                  purpose: "mail_import",
                  event: {
                    version: 1,
                    type: "browser_connected",
                    runId,
                    eventId: "synthetic-late-retired-delivery",
                  },
                }),
              );
              expect(
                z.object({ accepted: z.boolean() }).parse(await fenced.json()),
              ).toEqual({ accepted: false });
              const successors = await readSuccessors();
              observations.push({ boundary: "successor admitted", successors });
              expect(successors).toHaveLength(1);
              const successor = successors[0]!;
              expect(successor).toMatchObject({
                parentRunId: null,
                cause: "retry",
                attempt: 2,
              });
              await waitFor(
                async () =>
                  (
                    await database
                      .select()
                      .from(runTable)
                      .where(eq(runTable.id, successor.id))
                  )[0]?.status === "needs_review",
                "The clean successor did not settle its remaining investigation",
                6_000,
              );
              const settled = await readSuccessors();
              observations.push({
                boundary: "successor settled with unresolved work",
                successors: settled,
              });
              expect(settled[0]?.endedAt).toBeInstanceOf(Date);
              const tasks = settled[0]!.targets;
              expect(tasks).toHaveLength(1);
              expect(tasks[0]).toMatchObject({
                workKey: remaining.id,
                outcome: "researched_with_gaps",
                state: "unresolved",
              });
              expect(
                (
                  await database
                    .select()
                    .from(orderMail)
                    .where(eq(orderMail.id, newsletter.id))
                ).every(
                  (source) =>
                    source.sender === "" &&
                    source.subject === "" &&
                    source.content.bodyText === null,
                ),
              ).toBe(true);
              const [marker] = await database
                .select()
                .from(mailboxMessage)
                .where(
                  and(
                    eq(mailboxMessage.messageId, newsletter.messageId),
                    eq(mailboxMessage.ledgerPartyId, member.id),
                  ),
                );
              expect(marker).toMatchObject({
                classification: "unrelated",
                status: "completed",
                orderMailId: null,
                runId: null,
                checksum: newsletter.rawChecksum,
              });
              expect(
                (
                  await database
                    .select()
                    .from(orderMail)
                    .where(eq(orderMail.id, remaining.id))
                )[0]?.content,
              ).toEqual(remaining.content);
              expect(
                await database
                  .select()
                  .from(runEvidence)
                  .where(eq(runEvidence.runId, runEntityId.parse(runId))),
              ).toHaveLength(0);
              expect(
                await database
                  .select()
                  .from(runOperation)
                  .where(eq(runOperation.runId, runEntityId.parse(runId))),
              ).toHaveLength(0);
              for (const item of retainedObjects)
                expect(await storage.bucket.get(item.objectKey!)).toBeNull();
              expect(await database.select().from(purchase)).toHaveLength(0);
              expect(await database.select().from(expense)).toHaveLength(0);
              expect(await controls.violations()).toEqual([]);
              observations.push({
                boundary: "completed cleanup and honest successor",
                receiptId: receipt.id,
                disposed: true,
                successor: successor.shortcode,
                predecessor: retired?.shortcode,
                outcome: tasks[0]?.outcome,
              });
            } finally {
              const successors = await readSuccessors();
              observations.push({
                receipt: (
                  await database
                    .select()
                    .from(researchRetention)
                    .where(eq(researchRetention.id, receipt.id))
                )[0],
                emitted: await controls.emitted(),
                successors,
                successorDiagnostics: await Promise.all(
                  successors.map(async (successor) => ({
                    successor: successor.shortcode,
                    diagnostic: await workerdDiagnostic(
                      ctx.db,
                      successor.id,
                      runtime.harness,
                    ),
                  })),
                ),
                diagnostic: await workerdDiagnostic(
                  ctx.db,
                  runId,
                  runtime.harness,
                ),
              });
            }
            status = "passed";
          },
        );
      } catch (error) {
        observations.push({
          phase: started ? "scenario" : "setup",
          failure: scrubErrorMessage(
            error instanceof Error ? error.message : String(error),
          ),
        });
        throw error;
      } finally {
        await storage.close();
        const evidencePath = path.join(outputDir, "evidence.json");
        writeFileSync(
          evidencePath,
          `${JSON.stringify({ synthetic: true, delivery, status, observations, sourceChecksums: sources.map((source) => source.rawChecksum), limits: ["Scripted synthetic researcher and assessor; no paid evaluation", "Source-only cleanup: device-bound browser forget is covered separately"] }, null, 2)}\n`,
        );
        writeE2ERunBundle({
          repoRoot,
          outputDir,
          evidence: [evidencePath],
          kind: "browser",
          status,
          command: [
            "pnpm",
            "--dir",
            "apps/web",
            "test:postgres",
            "src/server/purchase-import/purchase-research-workerd.integration.test.ts",
            "-t",
            "cleanup delivery",
          ],
          profile: "purchase-agent",
          scenario: `synthetic-unrelated-mail-${delivery}`,
          started,
          build: readWebBuildProvenance(repoRoot),
          cases: [
            {
              name: `${delivery} unrelated mail cleanup`,
              status,
              durationMs: Date.now() - began,
            },
          ],
        });
      }
    },
    90_000,
  );
});
