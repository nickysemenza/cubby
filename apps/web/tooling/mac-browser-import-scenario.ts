import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { researchObjectivesRunInput } from "@cubby/schemas/run-fields";
import { testUserId } from "@cubby/schemas/testing";
import { pollUntil } from "@cubby/shared/retry";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

import {
  run as runTable,
  runEvidence,
  runOperation,
  runTarget,
} from "../src/server/db/schema";
import {
  browserCommandRecord,
  productionBrowserEvidenceStorage,
} from "../src/server/purchase-import/browser-results";
import type { ResearchBrowserEnvironment } from "../src/server/purchase-import/research-browser-service";
import { dispatchRunEvent } from "../src/server/purchase-import/dispatch";
import { authorizePurchaseAgent } from "../src/server/purchase-import/purchase-agent-workerd.fixtures";
import { startOrResumeRun } from "../src/server/purchase-import/run-service";
import type { PurchaseAgentQueueProducer } from "../src/server/purchase-agent-queue-types";
import { getDb } from "../src/server/repo/database-helpers";
import {
  currentMemberLedgerParty,
  setMemberLoginParty,
} from "../src/server/repo/member-login";
import { resolveOrThrow } from "../src/server/repo/shortcode-resolver";
import { buildEntity } from "./factories/build";
import { MacImportDriver } from "./mac-import-driver";
import type { createMacRetailerFixture } from "./mac-retailer-fixture";
import { from, type ScriptStep } from "./purchase-agent-script";
import { scenarioControls } from "./purchase-agent-workerd-harness";
import {
  buildKernelContext,
  buildScenarioDatabase,
  createFixtureWithContext,
} from "./scenarios/context";
import type { WorkerdRuntime } from "./workerd-runtime";

type Input = {
  runtime: WorkerdRuntime;
  userId: string;
  artifacts: string;
  repoRoot: string;
  nonce: string;
  retailer: Awaited<ReturnType<typeof createMacRetailerFixture>>;
};

const observe = (
  call: string,
  action: Extract<ScriptStep, { call: string }>["args"],
): ScriptStep => ({
  call,
  tool: "work_observe",
  args: { workRef: from("native-next", "work.workRef"), action },
});

/** Only external decisions are scripted; actual native snapshots cross the real coordinator and SDK. */
export async function createMacBrowserScenario(input: Input) {
  const pool = new Pool({ connectionString: input.runtime.databaseUrl });
  const db = buildScenarioDatabase(pool);
  const database = getDb(db);
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
        browserSyncEnabled: true,
        status: "active",
      }),
    );
    const accountId = await resolveOrThrow(db, "vendorAccount", account.id);
    await authorizePurchaseAgent(db, kernel.auth.userId);
    const controls = scenarioControls(input.runtime.harness);
    const orderURL = `${input.retailer.origin}/orders/order-001`;
    const productURL = `${input.retailer.origin}/products/black-crew-shirt`;
    const steps: ScriptStep[] = [
      { gate: "native-start-ready" },
      { call: "native-next", tool: "work_next", args: {} },
      observe("native-auth-history", {
        kind: "navigate",
        url: input.retailer.historyURL,
      }),
      { check: "native-auth-history", includes: "waiting" },
      { gate: "native-history-ready" },
      observe("native-order-navigate", { kind: "navigate", url: orderURL }),
      observe("native-order-read", { kind: "read" }),
      { gate: "native-order-ready" },
      observe("native-product-navigate", {
        kind: "navigate",
        url: productURL,
      }),
      observe("native-product-read", { kind: "read" }),
      { gate: "native-product-ready" },
    ];
    await controls.configure({
      // Composed photo review supplies its decisions through the owning services;
      // another purpose must not consume this account-history script.
      steps: [{ gate: "native-external-review" }],
      purposeSteps: { account_sync: steps },
    });
    const run = await startOrResumeRun(db, {
      ledgerPartyId: member.id,
      vendorAccountId: accountId,
      trigger: "manual",
    });
    const env = await input.runtime.harness
      .getWorker<{
        PURCHASE_IMPORT: ResearchBrowserEnvironment["PURCHASE_IMPORT"];
        PURCHASE_AGENT_QUEUE: PurchaseAgentQueueProducer;
      }>()
      .getEnv();
    const broker = env.PURCHASE_IMPORT.getByName(accountId);
    const scope = async () => {
      const [owned] = await database
        .select()
        .from(runTable)
        .where(eq(runTable.id, run.id));
      if (!owned) throw new Error("Native research Run is missing.");
      return owned;
    };
    const frozenInput = (await scope()).input;
    const frozen = researchObjectivesRunInput.parse(frozenInput);
    if (
      frozen.objectives.length !== 1 ||
      frozen.objectives[0]?.kind !== "account_history" ||
      frozen.objectives[0].vendorAccountId !== accountId
    )
      throw new Error(
        "Native research did not admit its exact owned account-history objective.",
      );
    const [target] = await database
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, run.id));
    if (!target || target.entityKind !== "run" || target.entityId !== run.id)
      throw new Error(
        "Native account research target identity is unavailable.",
      );
    const workRef = target.id;
    const commands = async () =>
      (
        await database
          .select()
          .from(runOperation)
          .where(eq(runOperation.runId, run.id))
      ).flatMap((row) => {
        const parsed = browserCommandRecord.safeParse(row.result);
        return parsed.success ? [parsed.data] : [];
      });
    const stages: Array<{
      stage: string;
      checksum: string;
      screenshots: number;
      durablyDelivered: true;
    }> = [];
    async function capturedRead(
      stage: string,
      sourceURL: string,
      gate: string,
    ) {
      const record = await pollUntil(
        async () => {
          const emitted = await controls.emitted();
          if (!emitted.includes(`gate:${gate}`)) return undefined;
          return (await commands()).find(
            (item) =>
              item.command.operation.type === "read" &&
              item.page?.research.observation.servedURL === sourceURL &&
              !item.page.research.observation.authenticationRequired &&
              item.observationDelivered,
          );
        },
        {
          label: `Actual Mac retained ${stage} and durable SDK acknowledgement`,
          timeoutMs: 30_000,
        },
      );
      if (
        !record.page ||
        record.workRef !== workRef ||
        record.brokerAccountId !== accountId ||
        record.command.runID !== run.id
      )
        throw new Error(
          "Actual Mac retained observation changed its Run, task, or account binding.",
        );
      const [original] = await database
        .select()
        .from(runEvidence)
        .where(eq(runEvidence.id, record.page.domEvidenceId));
      if (
        !original ||
        original.runId !== run.id ||
        original.targetId !== workRef ||
        (await sha256Hex(
          await productionBrowserEvidenceStorage.get(original.objectKey),
        )) !== original.checksum
      )
        throw new Error(
          "Actual Mac retained original bytes do not match their task/checksum.",
        );
      if (!record.page.capture.evidence.length)
        throw new Error(
          `Actual Mac ${stage} did not retain its screenshot document.`,
        );
      stages.push({
        stage,
        checksum: original.checksum,
        screenshots: record.page.capture.evidence.length,
        durablyDelivered: true,
      });
      return record.page.capture;
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
            { cause: error },
          );
        }
        if (!run.dispatchEventId)
          throw new Error("Native research dispatch identity is missing.");
        await dispatchRunEvent(db, env.PURCHASE_AGENT_QUEUE, {
          version: 1,
          type: "start_or_resume",
          runId: run.id,
          purpose: "account_sync",
          eventId: run.dispatchEventId,
        });
        await controls.release("native-start-ready");
        await pollUntil(
          async () =>
            (await scope()).status === "paused_auth" ? true : undefined,
          {
            label: "Actual signed-out native research auth pause",
            timeoutMs: 30_000,
          },
        );
        const signedOut = (await commands()).find(
          (item) => item.page?.research.observation.authenticationRequired,
        );
        if (
          !signedOut ||
          signedOut.workRef !== target.id ||
          signedOut.observationDelivered
        )
          throw new Error(
            "Signed-out research lost task binding or falsely acknowledged a useful observation.",
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
        const history = await capturedRead(
          "authenticated history",
          input.retailer.historyURL,
          "native-history-ready",
        );
        const resumed = await scope();
        if (
          resumed.status !== "running" ||
          JSON.stringify(resumed.input) !== JSON.stringify(frozenInput) ||
          !history.readableText.includes("order-001")
        )
          throw new Error(
            "Native Sync did not recover the same admitted Run/history objective.",
          );
        await controls.release("native-history-ready");
        const orderCapture = await capturedRead(
          "order detail",
          orderURL,
          "native-order-ready",
        );
        if (
          !orderCapture.readableText.includes("Black crew shirt") ||
          !orderCapture.readableText.includes("Total $29.99")
        )
          throw new Error(
            "Actual Mac order original is missing its shirt or stated money.",
          );
        await controls.release("native-order-ready");
        const productCapture = await capturedRead(
          "exact Product variant",
          productURL,
          "native-product-ready",
        );
        if (
          !productCapture.readableText.includes("00012345678905") ||
          !productCapture.readableText.includes("Exact color Black") ||
          !productCapture.readableText.includes("Size M")
        )
          throw new Error(
            "Actual Mac Product original is missing the exact black size-M variant/GTIN.",
          );
        const [currentTarget] = await database
          .select()
          .from(runTarget)
          .where(eq(runTarget.id, target.id));
        if (
          !currentTarget ||
          currentTarget.workKey !== target.workKey ||
          currentTarget.state !== target.state
        )
          throw new Error(
            "Native auth recovery changed or prematurely settled its admitted task.",
          );
        const violations = await controls.violations();
        if (violations.length)
          throw new Error(
            `Native scripted research boundary refused: ${JSON.stringify(violations)}`,
          );
        const file = path.join(input.artifacts, "native-browser-results.json");
        writeFileSync(
          file,
          JSON.stringify(
            {
              stages,
              originalRunResumed: true,
              originalTaskPreserved: true,
              coordinatorDecision:
                "typed work_next/work_observe; real researchResume and SDK receipt",
              browserIsolated: true,
              simulatedBrowserConnected: false,
              limits: [
                "External research choices scripted; economic and stock assertions belong to the composed native receipt journey",
              ],
            },
            null,
            2,
          ) + "\n",
        );
        appDriver.evidence.push(file);
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
