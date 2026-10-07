import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pollUntil } from "@cubby/shared/retry";
import { Pool } from "pg";
import { z } from "zod";
import {
  currentMemberLedgerParty,
  setMemberLoginParty,
} from "../src/server/repo/member-login";
import { resolveOrThrow } from "../src/server/repo/shortcode-resolver";
import {
  claimNextImportWork,
  issueBrowserCommand,
  readBrowserCommandResult,
  loadRunScope,
  startOrResumeRun,
  type PurchaseImportNamespace,
} from "../src/server/purchase-import/run-service";
import { executeLeasedOperation } from "../src/server/runs/operation";
import {
  buildKernelContext,
  buildScenarioDatabase,
  createFixtureWithContext,
} from "./scenarios/context";
import { MacImportDriver } from "./mac-import-driver";
import type { createMacRetailerFixture } from "./mac-retailer-fixture";
import type { WorkerdRuntime } from "./workerd-runtime";
import { buildEntity } from "./factories/build";

type Input = {
  runtime: WorkerdRuntime;
  userId: string;
  artifacts: string;
  repoRoot: string;
  nonce: string;
  retailer: Awaited<ReturnType<typeof createMacRetailerFixture>>;
};

/** Fixture setup creates only auth/vendor/run prerequisites; every capture crosses the real broker. */
export async function createMacBrowserScenario(input: Input) {
  const pool = new Pool({ connectionString: input.runtime.databaseUrl });
  const db = buildScenarioDatabase(pool);
  const kernel = buildKernelContext(db, testUserId(input.userId));
  const browserDriver = new MacImportDriver(
    input.repoRoot,
    input.artifacts,
    `fixture-browser-${input.nonce}`,
  );
  try {
    let member = await currentMemberLedgerParty(db, kernel.actorContext);
    if (!member) {
      const created = await createFixtureWithContext(
        kernel,
        "ledgerParty",
        buildEntity("ledgerParty", {
          name: "Synthetic Mac reviewer",
          kind: "member",
        }),
      );
      await setMemberLoginParty(
        db,
        kernel.auth.userId,
        parseShortcodeFor("ledgerParty", created.id),
        kernel.actorContext,
      );
      member = await currentMemberLedgerParty(db, kernel.actorContext);
    }
    if (!member) throw new Error("Synthetic Mac member identity is missing");
    const vendor = await createFixtureWithContext(
      kernel,
      "vendor",
      buildEntity("vendor", {
        name: "Synthetic Outfitters",
        website: input.retailer.origin,
        browserDomains: ["shop.example.test"],
        orderEvidence: "online_account",
      }),
    );
    const account = await createFixtureWithContext(
      kernel,
      "vendorAccount",
      buildEntity("vendorAccount", {
        label: "Synthetic Mac retailer",
        vendorId: vendor.id,
        ledgerPartyId: member.shortcode,
        browser: "chrome",
      }),
    );
    const accountId = await resolveOrThrow(db, "vendorAccount", account.id);
    const run = await startOrResumeRun(db, {
      ledgerPartyId: member.id,
      vendorAccountId: accountId,
      trigger: "manual",
    });
    const { PURCHASE_IMPORT: namespace } = await input.runtime.harness
      .getWorker<{ PURCHASE_IMPORT: PurchaseImportNamespace }>()
      .getEnv();
    const broker = namespace.getByName(accountId);
    const results: Array<{ stage: string; state: string }> = [];
    // DOM evidence stays in memory; the fixture retailer is reachable only
    // through the Mac, so every capture exercises the real app.
    const ports = testBrowserPorts();
    async function result(operationId: string) {
      return pollUntil(
        async () => {
          const response = await readBrowserCommandResult(
            db,
            namespace,
            { runId: run.id, operationId },
            ports,
          );
          return response.state === "pending" ? undefined : response;
        },
        {
          label: `Actual Mac broker result ${operationId}`,
          timeoutMs: 30_000,
        },
      );
    }
    async function capture(operationId: string, url: string) {
      await issueBrowserCommand(
        db,
        namespace,
        {
          runId: run.id,
          operationId,
          operation: {
            type: "capture",
            allowedHosts: ["shop.example.test"],
            screenshot: "preferred",
            recoveryURL: url,
          },
        },
        ports,
      );
      return result(operationId);
    }
    async function awaitNativeRetry(appDriver: MacImportDriver) {
      const continuation = input.runtime.harness.getWorker(
        "native-import-continuation",
      );
      const deliveries = z.object({
        retryEvents: z.array(
          z.object({ runId: z.string(), eventId: z.string() }),
        ),
      });
      try {
        const retry = await pollUntil(
          async () => {
            const { retryEvents } = deliveries.parse(
              await (
                await continuation.fetch("https://continuation.test/")
              ).json(),
            );
            return retryEvents.find((event) => event.runId === run.id);
          },
          { label: "Native Sync retry delivery", timeoutMs: 30_000 },
        );
        // The coordinator's decision on a retry: claim the run's next work,
        // as its `claim_next_import_work` tool does.
        const operationId = `native-resume:${retry.eventId}`;
        await executeLeasedOperation(
          db,
          {
            runId: run.id,
            operationId,
            kind: "claim_next_work",
            payload: { runId: run.id, operationId },
          },
          () => claimNextImportWork(db, namespace, run.id),
        );
        await pollUntil(
          async () =>
            (await loadRunScope(db, run.id)).public.status === "running"
              ? true
              : undefined,
          { label: "Native Sync resume", timeoutMs: 30_000 },
        );
        return [retry];
      } catch (error) {
        await appDriver.snapshot();
        throw new Error(
          `Native Sync now did not resume the original fixture run (status ${(await loadRunScope(db, run.id)).public.status})`,
          { cause: error },
        );
      }
    }
    return {
      context: {
        db,
        kernel,
        member,
        vendor,
        account,
        run,
        retailerOrigin: input.retailer.origin,
      },
      evidence: browserDriver.evidence,
      async run(appDriver: MacImportDriver) {
        await appDriver.openSettings();
        await appDriver.click("id=settings.purchaseImport.reconnect");
        try {
          await pollUntil(
            async () => ((await broker.connected()) ? true : undefined),
            { label: "Mac app broker connection", timeoutMs: 30_000 },
          );
        } catch (error) {
          const file = path.join(
            input.artifacts,
            "browser-connect-failure.txt",
          );
          writeFileSync(
            file,
            (await appDriver.snapshot()).replace(
              /Session token \([^)]*\)/gu,
              "Session token (fixture credential)",
            ),
          );
          appDriver.evidence.push(file);
          throw new Error(
            "Actual Mac app did not connect to the fixture broker",
            {
              cause: error,
            },
          );
        }
        const before = await capture(
          "mac:authentication",
          input.retailer.historyURL,
        );
        results.push({ stage: "signed-out capture", state: before.state });
        if (before.state !== "paused_auth")
          throw new Error(
            `Signed-out Mac capture did not pause authentication: ${before.state}`,
          );
        await appDriver.openSettings();
        await appDriver.wait(
          `id=settings.purchaseImport.openSignIn.${account.id}`,
        );
        await appDriver.click(
          `id=settings.purchaseImport.openSignIn.${account.id}`,
        );
        await browserDriver.open(input.retailer.bundleID, input.retailer.pid);
        await browserDriver.wait(
          'label="Sign in to fixture retailer" role=Button',
        );
        await browserDriver.click('label="Sign in to fixture retailer"');
        await browserDriver.wait('text="Your orders"');
        await browserDriver.screenshot("retailer-signed-in");
        await appDriver.click("id=settings.purchaseImport.syncNow");
        const resumedEvents = await awaitNativeRetry(appDriver);
        const history = await capture("mac:history", input.retailer.historyURL);
        if (
          history.state !== "completed" ||
          !history.capture?.readableText.includes("order-001")
        )
          throw new Error(
            "Actual resumed Mac history capture is missing order-001",
          );
        results.push({ stage: "resumed original run", state: history.state });
        const order = await capture(
          "mac:order",
          `${input.retailer.origin}/orders/order-001`,
        );
        if (
          order.state !== "completed" ||
          !order.capture?.readableText.includes("Black crew shirt")
        )
          throw new Error(
            "Actual Mac order capture is missing the exact shirt variant",
          );
        results.push({ stage: "order capture", state: order.state });
        const product = await capture(
          "mac:product",
          `${input.retailer.origin}/products/black-crew-shirt`,
        );
        if (
          product.state !== "completed" ||
          !product.capture?.readableText.includes("00012345678905")
        )
          throw new Error(
            "Actual Mac exact product capture is missing GTIN evidence",
          );
        const orderCapture = order.capture;
        const productCapture = product.capture;
        if (!orderCapture || !productCapture)
          throw new Error("Actual browser captures are unavailable");
        const evidence = path.join(
          input.artifacts,
          "native-browser-results.json",
        );
        writeFileSync(
          evidence,
          JSON.stringify(
            {
              stages: results,
              originalRunResumed: true,
              nativeSyncRetryDelivered: resumedEvents.some(
                (event) => event.runId === run.id,
              ),
              coordinatorDecision: "deterministic claim_next_import_work",
              browserIsolated: true,
            },
            null,
            2,
          ) + "\n",
        );
        appDriver.evidence.push(evidence);
        return { orderCapture, productCapture };
      },
      async close() {
        await browserDriver.close().catch(() => {});
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
