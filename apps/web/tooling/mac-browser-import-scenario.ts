import { ledgerPartyCreateInput } from "@cubby/schemas/ledger-party";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { vendorAccountCreateInput } from "@cubby/schemas/vendor-account";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { Pool } from "pg";
import {
  currentMemberLedgerParty,
  setMemberLoginParty,
} from "../src/server/repo/member-login";
import { resolveOrThrow } from "../src/server/repo/shortcode-resolver";
import {
  issueBrowserCommand,
  readBrowserCommandResult,
  loadRunScope,
  startOrResumeRun,
  type PurchaseImportNamespace,
} from "../src/server/purchase-import/run-service";
import {
  buildKernelContext,
  buildScenarioDatabase,
  createFixtureWithContext,
} from "./scenarios/context";
import { MacImportDriver } from "./mac-import-driver";
import type { createLocalWorkerdHarness } from "./local-workerd-harness";
import type { createMacRetailerFixture } from "./mac-retailer-fixture";

type Input = {
  databaseURL: string;
  userId: string;
  artifacts: string;
  repoRoot: string;
  nonce: string;
  harness: ReturnType<typeof createLocalWorkerdHarness>;
  retailer: Awaited<ReturnType<typeof createMacRetailerFixture>>;
};

/** Fixture setup creates only auth/vendor/run prerequisites; every capture crosses the real broker. */
export async function createMacBrowserScenario(input: Input) {
  const pool = new Pool({ connectionString: input.databaseURL });
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
        ledgerPartyCreateInput.parse({
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
      vendorCreateInput.parse({
        name: "Synthetic Outfitters",
        website: input.retailer.origin,
        browserDomains: ["shop.example.test"],
        orderEvidence: "online_account",
      }),
    );
    const account = await createFixtureWithContext(
      kernel,
      "vendorAccount",
      vendorAccountCreateInput.parse({
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
    const { PURCHASE_IMPORT: namespace } = await input.harness
      .getWorker<{ PURCHASE_IMPORT: PurchaseImportNamespace }>()
      .getEnv();
    const broker = namespace.getByName(accountId);
    const results: Array<{ stage: string; state: string }> = [];
    async function result(operationId: string) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const response = await readBrowserCommandResult(db, namespace, {
          runId: run.id,
          operationId,
        });
        if (response.state !== "pending") return response;
        await setTimeout(250);
      }
      throw new Error(`Actual Mac broker result timed out: ${operationId}`);
    }
    async function capture(operationId: string, url: string) {
      await issueBrowserCommand(db, namespace, {
        runId: run.id,
        operationId,
        operation: {
          type: "capture",
          allowedHosts: ["shop.example.test"],
          enhancedEvidence: false,
          recoveryURL: url,
        },
      });
      return result(operationId);
    }
    return {
      evidence: browserDriver.evidence,
      async run(appDriver: MacImportDriver) {
        const deadline = Date.now() + 30_000;
        while (!(await broker.connected())) {
          if (Date.now() >= deadline)
            throw new Error(
              "Actual Mac app did not connect to the fixture broker",
            );
          await setTimeout(250);
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
        await browserDriver.click('label="Sign in to fixture retailer"');
        await browserDriver.wait('text="Your orders"');
        await browserDriver.screenshot("retailer-signed-in");
        await appDriver.click("id=settings.purchaseImport.syncNow");
        while ((await loadRunScope(db, run.id)).public.status !== "running") {
          if (Date.now() >= deadline + 30_000)
            throw new Error(
              "Native Sync now did not resume the original fixture run",
            );
          await setTimeout(250);
        }
        const history = await capture("mac:history", input.retailer.historyURL);
        if (
          history.state !== "completed" ||
          history.result.outcome.status !== "completed" ||
          !history.result.outcome.capture?.readableText.includes("order-001")
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
          order.result.outcome.status !== "completed" ||
          !order.result.outcome.capture?.readableText.includes(
            "Black crew shirt",
          )
        )
          throw new Error(
            "Actual Mac order capture is missing the exact shirt variant",
          );
        results.push({ stage: "order capture", state: order.state });
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
              browserIsolated: true,
            },
            null,
            2,
          ) + "\n",
        );
        appDriver.evidence.push(evidence);
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
