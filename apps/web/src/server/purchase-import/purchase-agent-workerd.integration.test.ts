/* eslint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening -- The harness adapts generated Wrangler JSON whose binding dictionaries have no source-level owner type. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { and, eq } from "drizzle-orm";
import { type TestDbContext, withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "wrangler";
import { z } from "zod";

import {
  auditLog,
  expense,
  financialTransaction,
  financialTransactionAllocation,
  image,
  importRun,
  importRunMutation,
  importRunOperation,
  importSourceClaim,
  oauthRefreshToken,
  product,
  productImage,
  purchase,
  purchaseImage,
  purchasePaymentEvidence,
  session,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  ensurePurchaseAgentOAuthClient,
  PURCHASE_AGENT_OAUTH_CLIENT_ID,
} from "./agent-auth";
import { startTargetedImportRun } from "./run-service";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const agentConfigPath = path.join(
  webRoot,
  "../purchase-agent/dist/purchase_agent/wrangler.json",
);
let harness: TestHarness | undefined;

function workerdAgentConfig() {
  const config = JSON.parse(readFileSync(agentConfigPath, "utf8")) as {
    services?: Array<Record<string, unknown>>;
    queues?: { consumers?: Array<Record<string, unknown>> };
  };
  return {
    ...config,
    main: "../purchase-agent/dist/purchase_agent/index.js",
    queues: {
      ...config.queues,
      consumers: config.queues?.consumers?.map((consumer) => ({
        ...consumer,
        max_batch_timeout: 0,
      })),
    },
    services: [
      ...(config.services ?? []).map((service) =>
        service.binding === "CUBBY_PURCHASE_SERVICE"
          ? { ...service, service: "cubby" }
          : service,
      ),
      {
        binding: "CUBBY_PURCHASE_AGENT_TEST_MODEL",
        service: "cubby-test-model",
      },
    ],
  };
}

function workerdWebConfig() {
  const config = JSON.parse(
    readFileSync(path.join(webRoot, "dist/server/wrangler.json"), "utf8"),
  ) as Record<string, unknown> & {
    main?: string;
    services?: Array<Record<string, unknown>>;
  };
  // Keep the current compiled Worker but mirror E2E global setup: neither
  // binding has a local runtime and this harness owns agent queue delivery.
  delete config.ai;
  delete config.vectorize;
  const queues = config.queues as Record<string, unknown> | undefined;
  if (queues) queues.consumers = [];
  // `configPath` resolves this relative to dist/server; the inline config is
  // rooted at apps/web, so retain the compiled entrypoint explicitly.
  config.main = `dist/server/${config.main ?? "index.js"}`;
  const assets = config.assets as Record<string, unknown> | undefined;
  if (assets) assets.directory = "dist/client";
  config.services = (config.services ?? []).map((service) => {
    const replacements: Record<string, string> = {
      USDA_API: "e2e-usda-empty",
      UPC_LOOKUP: "e2e-upc-empty",
      PURCHASE_AGENT: "purchase-agent",
    };
    const binding = String(service.binding ?? "");
    return replacements[binding]
      ? { ...service, service: replacements[binding] }
      : service;
  });
  return config;
}

function createWorkerdHarness(databaseUrl: string) {
  return createTestHarness({
    root: webRoot,
    workers: [
      {
        config: {
          name: "cubby-queue-producer",
          main: "tests/e2e/harness-services/purchase-agent-queue-producer.ts",
          compatibility_date: "2026-09-19",
          queues: {
            producers: [
              {
                binding: "PURCHASE_AGENT_QUEUE",
                queue: "cubby-purchase-agent",
              },
            ],
          },
          durable_objects: {
            bindings: [
              {
                name: "PURCHASE_IMPORT_CLIENT",
                class_name: "PurchaseImportDurableObject",
                script_name: "cubby",
              },
            ],
          },
        },
      },
      {
        config: workerdWebConfig(),
        vars: {
          ALLOW_SIGNUP: "true",
          INSECURE_AUTH_COOKIES: "true",
          E2E_AUTH_TEST_MODE: "true",
          DATABASE_URL: databaseUrl,
          R2_ENDPOINT: "http://127.0.0.1:9",
          R2_PUBLIC_URL: "http://127.0.0.1:9",
          R2_BUCKET_NAME: "e2e-bucket",
          R2_KEY_PREFIX: "e2e",
          R2_ACCESS_KEY_ID: "dummy",
          R2_SECRET_ACCESS_KEY: "dummy",
          USDA_API_URL: "http://127.0.0.1:9/",
        },
        secrets: { BETTER_AUTH_SECRET: "workerd-test-secret" },
      },
      { config: workerdAgentConfig() },
      {
        config: {
          name: "cubby-test-model",
          main: "tests/e2e/harness-services/purchase-agent-test-model.ts",
          compatibility_date: "2026-09-19",
        },
      },
      {
        config: {
          name: "e2e-usda-empty",
          main: "tests/e2e/harness-services/usda-empty.ts",
          compatibility_date: "2026-09-19",
        },
      },
      {
        config: {
          name: "e2e-upc-empty",
          main: "tests/e2e/harness-services/upc-empty.ts",
          compatibility_date: "2026-09-19",
        },
      },
    ],
  });
}

async function waitFor(predicate: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function workerdDiagnostic(db: TestDbContext["db"], runId: string) {
  const [run, operations] = await Promise.all([
    getDb(db)
      .select({
        status: importRun.status,
        failureCode: importRun.failureCode,
        dispatchError: importRun.dispatchError,
        dispatchAttempts: importRun.dispatchAttempts,
        coordinatorStartedAt: importRun.coordinatorStartedAt,
      })
      .from(importRun)
      .where(eq(importRun.id, runId)),
    getDb(db)
      .select({
        operationId: importRunOperation.operationId,
        kind: importRunOperation.kind,
        state: importRunOperation.state,
        result: importRunOperation.result,
        error: importRunOperation.error,
      })
      .from(importRunOperation)
      .where(eq(importRunOperation.runId, runId)),
  ]);
  return JSON.stringify({ run, operations, logs: harness?.getLogs() });
}

async function protectedBusinessSnapshot(
  db: TestDbContext["db"],
  input: {
    purchaseId: typeof purchase.$inferSelect.id;
    productId: typeof product.$inferSelect.id;
    runId: string;
  },
) {
  const database = getDb(db);
  const values = await Promise.all([
    database.select().from(purchase).where(eq(purchase.id, input.purchaseId)),
    database
      .select()
      .from(expense)
      .where(eq(expense.purchaseId, input.purchaseId)),
    database.select().from(product).where(eq(product.id, input.productId)),
    database.select().from(image),
    database
      .select()
      .from(purchaseImage)
      .where(eq(purchaseImage.purchaseId, input.purchaseId)),
    database
      .select()
      .from(productImage)
      .where(eq(productImage.productId, input.productId)),
    database.select().from(importSourceClaim),
    database.select().from(purchasePaymentEvidence),
    database.select().from(financialTransaction),
    database.select().from(financialTransactionAllocation),
    database.select().from(auditLog),
    database
      .select()
      .from(importRunMutation)
      .where(eq(importRunMutation.runId, input.runId)),
  ]);
  return JSON.stringify(values);
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("purchase-agent coupled two-Worker workerd harness", () => {
  const ctx = withTestDb();

  it("uses the production service to fence, pause for browser evidence, resume, and complete without business writes", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Workerd harness member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Workerd harness vendor",
      website: "https://shop.example.test/orders",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Workerd harness account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const targetPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: account.id,
      orderId: "ORDER-WORKERD-1",
      date: "2026-09-20",
      displayLabel: "Workerd validation target",
      statedTotal: 12.34,
    });
    const targetProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Workerd validation product" }),
      ctx.actor,
    );
    const [targetProductRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, targetProduct.entityId));
    if (!targetProductRow) throw new Error("Expected validation Product");
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: targetPurchase.id,
      name: "Workerd validation product",
      cost: 12.34,
      date: "2026-09-20",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
      productId: targetProduct.entityId,
      productQuantity: 1,
    });
    await ensurePurchaseAgentOAuthClient(ctx.db);
    const now = new Date();
    const sessionId = "purchase-agent-workerd-session";
    await getDb(ctx.db)
      .insert(session)
      .values({
        id: sessionId,
        token: "purchase-agent-workerd-session-token",
        userId: ctx.actor.userId,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        createdAt: now,
        updatedAt: now,
      });
    await getDb(ctx.db)
      .insert(oauthRefreshToken)
      .values({
        id: "purchase-agent-workerd-grant",
        token: "purchase-agent-workerd-refresh-token",
        clientId: PURCHASE_AGENT_OAUTH_CLIENT_ID,
        sessionId,
        userId: ctx.actor.userId,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        createdAt: now,
        authTime: now,
        scopes: ["openid", "profile", "email", "offline_access"],
      });
    const sourceExternalKey = "workerd:ORDER-WORKERD-1";
    const evidenceChecksum = "a".repeat(64);
    const started = await startTargetedImportRun(ctx.db, {
      ledgerPartyId: party.id,
      purpose: "purchase_validation",
      vendorId: vendor.id,
      vendorAccountId: account.id,
      trigger: "manual",
      targets: [
        {
          kind: "purchase",
          purchaseId: targetPurchase.id,
          vendorAccountId: account.id,
          sourceKind: "browser_order",
          sourceExternalKey,
          targetFingerprint: "a".repeat(64),
          evidenceFingerprint: evidenceChecksum,
        },
      ],
    });
    if (!started.created || !started.run.dispatchEventId)
      throw new Error("Expected targeted run dispatch generation");

    const before = await protectedBusinessSnapshot(ctx.db, {
      purchaseId: targetPurchase.id,
      productId: targetProduct.entityId,
      runId: started.run.id,
    });
    const previousHyperdrive = new Map(
      [
        "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
        "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED",
      ].map((key) => [key, process.env[key]]),
    );
    for (const key of previousHyperdrive.keys())
      process.env[key] = ctx.databaseUrl;
    try {
      harness = createWorkerdHarness(ctx.databaseUrl);
      const { url } = await harness.listen();
      const model = harness.getWorker("cubby-test-model");
      expect(
        (
          await model.fetch("https://model.test/configure", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              runPublicId: started.run.publicId,
              productShortcode: targetProductRow.shortcode,
              sourceExternalKey,
              evidenceChecksum,
            }),
          })
        ).status,
      ).toBe(204);
      const dispatch = (event: Record<string, unknown>) =>
        fetch(new URL("/dispatch", url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
        });
      const startEvent = {
        version: 1,
        type: "start_or_resume",
        runId: started.run.id,
        publicId: started.run.publicId,
        purpose: "purchase_validation",
        eventId: started.run.dispatchEventId,
      };
      expect((await dispatch(startEvent)).status).toBe(202);
      let browserCommand:
        | { commandId: string; operationId: string }
        | undefined;
      try {
        await waitFor(async () => {
          const [operation] = await getDb(ctx.db)
            .select({
              operationId: importRunOperation.operationId,
              result: importRunOperation.result,
            })
            .from(importRunOperation)
            .where(
              and(
                eq(importRunOperation.runId, started.run.id),
                eq(importRunOperation.kind, "browser_command"),
              ),
            )
            .limit(1);
          const parsed = z
            .object({ commandId: z.uuid() })
            .safeParse(operation?.result);
          browserCommand = parsed.success
            ? {
                commandId: parsed.data.commandId,
                operationId: operation?.operationId ?? "",
              }
            : undefined;
          return Boolean(browserCommand?.operationId);
        }, "Production service never persisted browser command");
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${await workerdDiagnostic(ctx.db, started.run.id)}`,
          { cause: error },
        );
      }

      expect(
        (
          await fetch(new URL("/browser-result", url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              vendorAccountId: account.id,
              ledgerPartyId: party.id,
              userId: ctx.actor.userId,
              runId: started.run.id,
              commandId: z.uuid().parse(browserCommand?.commandId),
              operationId: browserCommand?.operationId,
            }),
          })
        ).status,
      ).toBe(202);
      try {
        await waitFor(async () => {
          const [run] = await getDb(ctx.db)
            .select({
              status: importRun.status,
              coordinatorStartedAt: importRun.coordinatorStartedAt,
            })
            .from(importRun)
            .where(eq(importRun.id, started.run.id));
          return (
            run?.status === "completed" && run.coordinatorStartedAt !== null
          );
        }, "Production service never finalized targeted run");
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${await workerdDiagnostic(ctx.db, started.run.id)}`,
          { cause: error },
        );
      }
      const after = await protectedBusinessSnapshot(ctx.db, {
        purchaseId: targetPurchase.id,
        productId: targetProduct.entityId,
        runId: started.run.id,
      });
      expect(after).toEqual(before);
    } finally {
      for (const [key, value] of previousHyperdrive) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);
});
