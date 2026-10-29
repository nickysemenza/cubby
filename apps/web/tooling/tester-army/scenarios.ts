import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import type { Pool } from "pg";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { testUserId } from "@cubby/schemas/testing";
import {
  parseEntityId,
  imageShortcode,
  runShortcode,
} from "@cubby/schemas/identifiers";
import { runProgressEvent } from "@cubby/schemas/run-fields";
import { getDb } from "~/server/db/helpers";
import { drizzleSchema as schema } from "~/server/db/drizzle-schema";
import { retainedMailFixture } from "~/server/domains/purchase-import/operations/order-import.fixtures";
import { enableSyntheticMailImport } from "~/server/domains/purchase-import/repo/purchase-agent-workerd.fixtures";
import { startPhotoInventoryRun } from "~/server/domains/purchase-import/repo/run-service";
import { seedRunFinding } from "~/server/testing/run-finding.fixtures";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { inspectImageFile } from "~/server/domains/image/repo/image-integrity";
import {
  buildKernelContext,
  buildScenarioDatabase,
} from "../scenarios/context";
import { createEntity } from "../factories/create";
import {
  call,
  from,
  mcp,
  mcpRead,
  currentRunId,
  type ScriptStep,
} from "../purchase-agent-script";
import type { E2EWorkerRuntime } from "../../tests/e2e/support/e2e-worker-runtime";
import { operationCall } from "../../tests/e2e/support/operation";

/** Seeds sources only. Production Jobs, processors and writers produce the imported records. */
export async function seedImportJourneys({
  pool,
  userId,
  client,
  runtime,
}: {
  pool: Pool;
  userId: string;
  client: APIRequestContext;
  runtime: E2EWorkerRuntime;
}) {
  const db = buildScenarioDatabase(pool);
  const context = buildKernelContext(db, testUserId(userId));
  const rows = await pool.query<{ id: string }>(
    'SELECT id FROM "LedgerParty" WHERE "userId" = $1 AND kind = $2 AND "deletedAt" IS NULL',
    [userId, "member"],
  );
  const member = rows.rows[0];
  assert(member, "Synthetic member is required");
  const memberId = parseEntityId("ledgerParty", member.id);
  const mailboxId = "synthetic-journey-mailbox";
  await enableSyntheticMailImport(
    { db, actor: context.actorContext },
    mailboxId,
  );
  const vendor = await createEntity(context, "vendor", {
    name: "Synthetic Journey Outfitters",
    website: "https://outfitters.example.test",
  });
  const vendorId = await resolveOrThrow(db, "vendor", vendor.id);
  const orderId = "SYN-JOURNEY-ORDER";
  const itemName = "Synthetic Journey Herb Packet";
  const productUrl = "https://outfitters.example.test/products/herb-packet";
  const source = async (event: "placed" | "shipped") => {
    const text =
      event === "placed"
        ? `Order ${orderId}. Ordered September 10, 2026. ${itemName}, SKU HERB-1, quantity 1, $5.00. Grand total $5.00 USD. Product: ${productUrl}`
        : `Order ${orderId} has shipped.`;
    const mail = await retainedMailFixture(db, {
      ledgerPartyId: memberId,
      vendorId,
      mailboxId,
      messageId: `synthetic-journey-${event}`,
      sender: "orders@outfitters.example.test",
      subject: `Synthetic journey order ${event}`,
      receivedAt: new Date(
        event === "placed" ? "2026-09-10T15:00:00Z" : "2026-09-11T15:00:00Z",
      ),
      checksum: createHash("sha256").update(text).digest("hex"),
      bodyText: text,
    });
    await getDb(db)
      .insert(schema.orderMailEvent)
      .values({
        orderMailId: mail.id,
        event,
        orderId,
        amount: event === "placed" ? 5 : null,
        currency: "USD",
        sourceKey: `synthetic:${mail.id}`,
      });
    const email = await getDb(db).query.email.findFirst({
      where: eq(schema.email.orderMailId, mail.id),
    });
    assert(email, "Synthetic source Email is required");
    return { mail, email };
  };
  const confirmation = await source("placed");
  const shipping = await source("shipped");
  const navigation = await insertWithShortcode(db, "email", {
    ledgerPartyId: memberId,
    mailboxId,
    messageId: "synthetic-navigation-receipt",
    sender: "receipts@example.test",
    subject: "Synthetic Email navigation receipt",
    receivedAt: new Date("2026-05-15T12:00:00Z"),
    checksum: "a".repeat(64),
    classification: "related",
    classificationVersion: "synthetic-navigation-v1",
    executionPolicy: "classification_only",
    status: "completed",
  });

  const consoleRun = await startPhotoInventoryRun(db, {
    actorUserId: testUserId(userId),
  });
  const consoleVendor = await createEntity(context, "vendor", {
    name: "Synthetic Console Vendor",
  });
  const consolePurchase = await createEntity(context, "purchase", {
    vendorId: consoleVendor.id,
    orderId: "SYN-CONSOLE-1",
  });
  const finding = await seedRunFinding(db, {
    runId: consoleRun.id,
    ledgerPartyId: memberId,
    entityKind: "purchase",
    entityId: await resolveOrThrow(db, "purchase", consolePurchase.id),
    kind: "synthetic_note",
    summary: "Synthetic finding to resolve",
    evidenceFingerprint: "b".repeat(64),
  });
  const progress = runProgressEvent.parse({
    eventId: "synthetic-progress-1",
    generation: "synthetic",
    sequence: 1,
    phase: "Reading synthetic orders",
    currentItem: "Synthetic order 7",
    detail: "Synthetic progress detail",
    awaitingApproval: false,
    createdAt: "2026-06-06T12:00:00Z",
  });
  await getDb(db)
    .update(schema.run)
    .set({
      liveProgress: progress,
      progressHistory: [progress],
      progressEventIds: [progress.eventId],
    })
    .where(eq(schema.run.id, consoleRun.id));

  async function native<S extends z.ZodType>(
    operation: string,
    input: z.core.util.JSONType,
    output: S,
  ) {
    const response = await operationCall(
      client,
      `photoImport.${operation}`,
      input,
    );
    assert(
      response.ok(),
      `Photo setup ${operation} failed: ${await response.text()}`,
    );
    return output.parse(response.body);
  }
  const clientBatchId = crypto.randomUUID();
  const { runId } = await native(
    "createRun",
    {
      processor: "cubby",
      clientBatchId,
      imageCount: 2,
      notes:
        "Synthetic slate shirt and brown boots, two separate wardrobe items.",
    },
    z.object({ runId: runShortcode }),
  );
  const photos = [];
  for (const [position, item] of ["shirt", "boots"].entries()) {
    const filename = `synthetic-wardrobe-${item}.jpg`;
    const bytes = await readFile(
      new URL(`../../tests/e2e/fixtures/${filename}`, import.meta.url),
    );
    const inspected = await inspectImageFile(bytes, "image/jpeg");
    assert(
      inspected.width && inspected.height,
      "Synthetic photo has no dimensions",
    );
    photos.push({
      position,
      item,
      bytes,
      metadata: {
        clientId: `synthetic-${item}`,
        filename,
        contentType: "image/jpeg",
        size: bytes.byteLength,
        width: inspected.width,
        height: inspected.height,
        sha256: inspected.sha256,
        allowExactReuse: true,
      },
    });
  }
  const staged = await native(
    "stage",
    { runId, items: photos.map((photo) => photo.metadata) },
    z.object({
      items: z.array(
        z.object({
          kind: z.literal("upload"),
          clientId: z.string(),
          imageId: imageShortcode,
          uploadUrl: z.url(),
        }),
      ),
    }),
  );
  const images = [];
  const groups = [];
  const closet = await createEntity(context, "location", {
    name: "Synthetic Wardrobe Closet",
  });
  for (const photo of photos) {
    const target = staged.items.find(
      (candidate) => candidate.clientId === photo.metadata.clientId,
    );
    assert(target, "Synthetic photo was not staged");
    const upload = await client.put(target.uploadUrl, {
      headers: { "content-type": "image/jpeg" },
      data: photo.bytes,
    });
    assert(upload.ok(), `Synthetic photo upload failed: ${upload.status()}`);
    images.push({
      imageId: target.imageId,
      position: photo.position,
      sha256: photo.metadata.sha256,
      width: photo.metadata.width,
      height: photo.metadata.height,
    });
    groups.push({
      groupKey: `journey-${photo.item}`,
      imageId: target.imageId,
      name:
        photo.item === "shirt"
          ? "Synthetic Journey Slate Shirt"
          : "Synthetic Journey Brown Boots",
    });
  }
  const controls = runtime.purchaseAgent;
  assert(controls, "Import journeys require the shared scripted model peers");
  const checksum = from("mail-read", "checksum");
  const mailSteps: ScriptStep[] = [
    call("mail-claim", "claim_next_import_work"),
    mcpRead("mail-read", "purchase_import_read", {
      action: "mail_read",
      mailboxId,
      messageId: confirmation.mail.messageId,
    }),
    mcp("mail-prepare", "purchase_import", currentRunId, {
      action: "prepare",
      orders: [
        {
          vendorId: vendor.id,
          stableOrderId: "journey-order",
          itemOperationId: "mail-prepare:order",
          source: {
            kind: "mail_message",
            externalKey: `gmail:${mailboxId}:${confirmation.mail.messageId}`,
            checksum,
          },
          evidenceChecksum: checksum,
          extractionRevision: "synthetic@1",
          extraction: {
            status: "ready",
            candidate: {
              orderId,
              orderedAt: "2026-09-10T15:00:00.000Z",
              merchant: "Synthetic Journey Outfitters",
              currency: "USD",
              printedGrandTotal: 5,
              lines: [
                {
                  title: itemName,
                  amount: 5,
                  lineKind: "principal",
                  quantity: 1,
                  sku: "HERB-1",
                  productUrl,
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: ["journey-order:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    }),
    mcp("mail-commit", "purchase_import", currentRunId, {
      action: "commit",
      prepareOperationId: "mail-prepare",
      defaultTrade: "other",
      resolutions: [
        {
          stableOrderId: "journey-order",
          stableLineId: "journey-order:line-1",
          resolution: { kind: "new" },
        },
      ],
    }),
    call("mail-done", "claim_next_import_work"),
    { check: "mail-done", includes: "none" },
  ];
  await controls.configure({
    steps: [],
    decisions: [
      {
        feature: "image-identification",
        match: "Classify the composition",
        label: "single_object",
      },
      {
        feature: "image-identification",
        match: "Does this image support",
        label: "single_identity",
      },
    ],
    purposeSteps: {
      mail_import: mailSteps,
      photo_inventory: [
        call("photo-claim", "claim_next_import_work"),
        mcp(
          "photo-propose",
          "photo_run",
          await resolveOrThrow(db, "run", runId),
          {
            action: "propose_groups",
            runId,
            groups: groups.map((group) => ({
              groupKey: group.groupKey,
              images: [{ id: group.imageId, purpose: "item" }],
              product: { kind: "create", create: { name: group.name } },
              inventory: { locationId: closet.id, quantity: 1 },
              review: {
                observedName: group.name,
                unresolvedReason: null,
                stockIntent: "receive",
              },
              evidence:
                "Synthetic wardrobe item photo; member approval creates the Product and stock.",
            })),
          },
        ),
        mcpRead("photo-list", "photo_run_read", { action: "proposals", runId }),
        call("photo-await", "report_agent_progress", {
          phase: "awaiting_approval",
          awaitingApproval: true,
          detail: "Two synthetic wardrobe items are ready for review",
        }),
      ],
    },
    imageDescription: {
      description:
        "Synthetic wardrobe item photographed against a plain background. Brand and size are unknown.",
      cutoutEligibility: "ineligible",
      claims: [{ text: "One synthetic wardrobe item", evidenceKind: "visual" }],
    },
  });
  // Configure model peers before admission can wake the real description/grouping Jobs.
  await native("finalize", { runId, clientBatchId, images }, z.looseObject({}));
  await native("sealBatch", { runId, clientBatchId }, z.looseObject({}));
  return {
    photo: { runId, groups },
    mail: {
      emailId: confirmation.email.shortcode,
      shippingEmailId: shipping.email.shortcode,
      vendorId: vendor.id,
      orderId,
      itemName,
      productUrl,
      mailboxId,
      messageId: confirmation.mail.messageId,
    },
    navigationEmailId: navigation.shortcode,
    console: { runId: consoleRun.publicId, findingId: finding.id },
  };
}
