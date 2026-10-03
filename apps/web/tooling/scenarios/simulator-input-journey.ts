import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import { pollUntil } from "@cubby/shared/retry";
import { testUserId } from "@cubby/schemas/testing";
import { imageId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import * as schema from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  listPhotoGroupProposals,
  listPhotoRunImages,
  proposePhotoGroups,
} from "~/server/photo-import-run/proposals";
import { updateImageProcessingSettings } from "~/server/repo/image-processing-maintenance";
import { completeDescribeImageJobs } from "../convergence-harness";
import {
  buildKernelContext,
  buildScenarioDatabase,
  createFixtureWithContext,
} from "./context";
import { buildEntity } from "../factories/build";

type Run = (
  command: string,
  args: string[],
  stdoutFile?: string,
) => Promise<void>;
const eventually = <T>(read: () => Promise<T | undefined>, label: string) =>
  pollUntil(read, { label, timeoutMs: 60_000 });

/** OS Files/Photos are synthetic inputs. CSV and image stage/PUT/finalize,
 * proposed-group review and approval all execute in the installed iOS app. */
export async function createSimulatorInputJourney(input: {
  pool: Pool;
  userId: string;
  repoRoot: string;
  artifacts: string;
  deviceID: string;
  common: string[];
  run: Run;
}) {
  const db = buildScenarioDatabase(input.pool);
  const database = getDb(db);
  const kernel = buildKernelContext(db, testUserId(input.userId));
  const member = await database.query.ledgerParty.findFirst({
    where: and(
      eq(schema.ledgerParty.userId, kernel.auth.userId),
      eq(schema.ledgerParty.kind, "member"),
      notDeleted(schema.ledgerParty),
    ),
  });
  if (!member) throw new Error("Synthetic simulator member missing");
  const card = await createFixtureWithContext(
    kernel,
    "financialAccount",
    buildEntity("financialAccount", {
      name: "Synthetic Input Card",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      ledgerPartyId: member.shortcode,
      sourceAliases: [
        {
          source: "monarch",
          alias: "Synthetic Input Card",
          externalAccountId: null,
        },
      ],
    }),
  );
  await updateImageProcessingSettings(db, { enabled: true, paused: false });
  const inputs = path.join(input.artifacts, "inputs");
  mkdirSync(inputs, { recursive: true });
  const csv = path.join(inputs, "synthetic-input-statement.csv");
  const image = path.join(inputs, "synthetic-input-shirt.png");
  writeFileSync(
    csv,
    "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Id\n2026-09-12,Synthetic Input Outfitters,Clothing,Synthetic Input Card,SYNTHETIC INPUT ORDER,,-42.50,synthetic-input-posted\n",
  );
  copyFileSync(
    path.join(
      input.repoRoot,
      "apps/web/tests/e2e/fixtures/synthetic-wardrobe-shirt.png",
    ),
    image,
  );
  const sha256 = createHash("sha256").update(readFileSync(image)).digest("hex");
  const replay = async (script: string) =>
    input.run("pnpm", [
      "exec",
      "agent-device",
      "test",
      `apps/apple/e2e/${script}.ad`,
      ...input.common,
      "--artifacts-dir",
      path.join(input.artifacts, script),
      "--reporter",
      "default",
      "--reporter",
      path.join(
        input.repoRoot,
        "apps/web/tooling/native-replay-progress-reporter.ts",
      ),
      "--reporter",
      `junit:${path.join(input.artifacts, `${script}.xml`)}`,
    ]);
  return {
    inputs: [csv, image],
    async installInputs(appDocuments: string) {
      mkdirSync(appDocuments, { recursive: true });
      copyFileSync(csv, path.join(appDocuments, path.basename(csv)));
      await input.run("xcrun", ["simctl", "addmedia", input.deviceID, image]);
    },
    async execute() {
      await replay("input-statement");
      const transactions = await database.query.financialTransaction.findMany({
        where: notDeleted(schema.financialTransaction),
      });
      if (transactions.length !== 1 || transactions[0]?.amount !== 42.5)
        throw new Error(
          "Native CSV decision did not create exactly the reviewed transaction",
        );
      const account = await database.query.financialAccount.findFirst({
        where: eq(schema.financialAccount.shortcode, card.id),
      });
      if (!account || transactions[0].accountId !== account.id)
        throw new Error(
          "Native statement used a different explicit account identity",
        );
      if (
        (
          await database.query.expense.findMany({
            where: notDeleted(schema.expense),
          })
        ).length
      )
        throw new Error("CSV source intake auto-booked an Expense");
      await replay("input-photo");
      const run = await eventually(
        async () =>
          database.query.run.findFirst({
            where: eq(schema.run.purpose, "photo_inventory"),
          }),
        "native-created photo Run",
      );
      const images = await eventually(async () => {
        const result = await listPhotoRunImages(db, run.shortcode);
        return result.length === 1 ? result : undefined;
      }, "native stage/PUT/finalize");
      const stored = await database.query.image.findFirst({
        where: eq(schema.image.shortcode, images[0]!.id),
      });
      if (!stored || stored.sha256 !== sha256)
        throw new Error("Native Photos input original digest changed");
      const jobs = await eventually(async () => {
        const found = await database.query.imageProcessingJob.findMany({
          where: and(
            eq(schema.imageProcessingJob.imageId, imageId.parse(stored.id)),
            eq(schema.imageProcessingJob.kind, "describe_image"),
          ),
        });
        return found.length === 1 ? found : undefined;
      }, "native finalization description job");
      await completeDescribeImageJobs(
        db,
        jobs,
        "Supplied synthetic model response: one gray crew shirt.",
      );
      await proposePhotoGroups(db, {
        runId: parseShortcodeFor("run", run.shortcode),
        groups: [
          {
            groupKey: "synthetic-input-shirt",
            images: [{ id: images[0]!.id, purpose: "item" }],
            product: {
              kind: "create",
              create: { name: "Synthetic Input Crew Shirt" },
            },
            evidence:
              "Supplied external grouping response for the actual native-uploaded synthetic photo.",
          },
        ],
      });
      if (
        (
          await database.query.product.findMany({
            where: notDeleted(schema.product),
          })
        ).length ||
        (
          await database.query.inventoryEntry.findMany({
            where: notDeleted(schema.inventoryEntry),
          })
        ).length
      )
        throw new Error(
          "Native photo proposals wrote Product or Inventory before approval",
        );
      await replay("input-photo-approval");
      await eventually(async () => {
        const review = await listPhotoGroupProposals(db, run.shortcode);
        return review.proposals[0]?.state === "committed" ? true : undefined;
      }, "native Product approval");
      const products = await database.query.product.findMany({
        where: notDeleted(schema.product),
      });
      if (
        products.length !== 1 ||
        products[0]?.name !== "Synthetic Input Crew Shirt"
      )
        throw new Error(
          "Native approval did not commit the reviewed Product exactly once",
        );
      const evidence = path.join(input.artifacts, "native-input-result.json");
      writeFileSync(
        evidence,
        JSON.stringify(
          {
            account: card.id,
            transaction: transactions[0].shortcode,
            photoRun: run.shortcode,
            imageSha256: sha256,
            products: products.length,
            expenseAutoWrites: 0,
            inventoryAutoWrites: 0,
            input: "actual Files CSV + PhotosPicker",
            decision: "actual native review + approval",
            model: "supplied external descriptions/grouping",
          },
          null,
          2,
        ),
      );
      return evidence;
    },
  };
}
