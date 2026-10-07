import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  imageShortcode,
  type LedgerPartyId,
  runShortcode,
} from "@cubby/schemas/identifiers";
import type { photoImportCreateRunInput } from "@cubby/schemas/photo-import-run";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { BrowserBridgeResult } from "@cubby/schemas/purchase-import";
import { testUserId } from "@cubby/schemas/testing";
import { and, eq, isNull } from "drizzle-orm";
import type { Pool } from "pg";
import { z } from "zod";

import {
  ledgerParty,
  orderMail,
  orderMailEvent,
  run as runTable,
} from "~/server/db/schema";
import { completedCapture } from "~/server/purchase-import/browser.fixtures";
import { authorizePurchaseAgent } from "~/server/purchase-import/purchase-agent-workerd.fixtures";
import { startOrResumeRun } from "~/server/purchase-import/run-service";
import type {
  PhotoImportFinalizeInput,
  PhotoImportStageInput,
} from "~/contracts/photo-import.contract";
import { getDb } from "~/server/repo/database-helpers";
import { updateImageProcessingSettings } from "~/server/repo/image-processing-maintenance";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { inspectImageFile } from "~/server/services/image-integrity";

import { seedBaseWorld } from "../factories/base-world";
import { LIVE_IMPORT } from "../tester-army/names";
import { buildScenarioDatabase } from "./context";
import { seedSimulatorPhotoActor } from "./simulator";
import type { JourneySeed } from "./tester-army-journeys";

/** What the coupled harness offers the seed beyond the database. */
type CoupledServices = {
  /** The harness's web origin and the member's session, for the native HTTP API. */
  origin: string;
  cookies: ReadonlyArray<{ name: string; value: string }>;
  /** Connects the simulated Mac browser; it answers each command by URL. */
  connectBrowser: (input: {
    vendorAccountId: string;
    ledgerPartyId: string;
    userId: string;
    outcomes: Record<string, BrowserBridgeResult["outcome"]>;
  }) => Promise<void>;
};

/**
 * Synthetic sources for the coupled journeys. Each journey owns its vendor or
 * run; the live journey produces everything else (the run's work, the
 * Purchase, the Products).
 */
export async function seedCoupledJourneys(
  pool: Pool,
  userId: string,
  services: CoupledServices,
): Promise<JourneySeed> {
  await seedSimulatorPhotoActor(pool, userId);
  const db = buildScenarioDatabase(pool);
  await seedBaseWorld(db.clientForRepository());
  const [member] = await getDb(db)
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.userId, testUserId(userId)),
        eq(ledgerParty.kind, "member"),
        isNull(ledgerParty.deletedAt),
      ),
    )
    .limit(1);
  if (!member) throw new Error("Synthetic member party was not seeded");
  // MCP delegation and photo grouping both require the member's agent grant.
  await authorizePurchaseAgent(db, userId);

  const seed: JourneySeed = {};

  // A saved, itemized confirmation the member imports from the vendor page,
  // plus its later shipping notice; once mail-only, once on a synced account.
  seed["import-order-mail"] = await seedSavedConfirmation(db, member.id, {
    ...LIVE_IMPORT.mail,
    synced: false,
  });
  seed["import-order-mail-enrich"] = await seedSavedConfirmation(
    db,
    member.id,
    { ...LIVE_IMPORT.enrich, synced: true },
  );

  // A fresh database starts with image processing paused; finalize would
  // schedule descriptions that no wakeup ever claims.
  await updateImageProcessingSettings(db, { enabled: true, paused: false });
  seed["import-photo-inventory"] = { run: await uploadPhotoRun(services) };

  seed["import-account-sync"] = await seedAccountSync(
    pool,
    member.id,
    userId,
    services,
  );
  return seed;
}

const apiError = z.object({ message: z.string() }).loose();

/** The native app's photo upload: create a run, stage, PUT the bytes, finalize. */
async function uploadPhotoRun(services: CoupledServices) {
  const headers = {
    "content-type": "application/json",
    cookie: services.cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; "),
    origin: services.origin,
  };
  const post = async <T>(
    operation: string,
    body:
      | z.input<typeof photoImportCreateRunInput>
      | PhotoImportStageInput
      | PhotoImportFinalizeInput,
    schema: z.ZodType<T>,
  ) => {
    const response = await fetch(
      `${services.origin}/api/v1/photoImport/${operation}`,
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    const json: unknown = await response.json();
    if (!response.ok)
      throw new Error(
        `photoImport.${operation} ${response.status}: ${apiError.safeParse(json).data?.message ?? JSON.stringify(json)}`,
      );
    return schema.parse(json);
  };
  const { runId } = await post(
    "createRun",
    { notes: "Synthetic wardrobe photos" },
    z.object({ runId: runShortcode }),
  );
  const photos = await Promise.all(
    LIVE_IMPORT.photos.map(async (name, position) => {
      const bytes = readFileSync(
        new URL(`../../tests/e2e/fixtures/${name}`, import.meta.url),
      );
      const inspected = await inspectImageFile(bytes, "image/jpeg");
      if (!inspected.width || !inspected.height)
        throw new Error(`Fixture ${name} has no readable dimensions`);
      return {
        position,
        bytes,
        item: {
          clientId: `synthetic-${position}`,
          filename: name,
          contentType: "image/jpeg" as const,
          size: bytes.byteLength,
          width: inspected.width,
          height: inspected.height,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          allowExactReuse: true,
        },
      };
    }),
  );
  const staged = await post(
    "stage",
    { runId, items: photos.map((photo) => photo.item) },
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
  for (const photo of photos) {
    const target = staged.items.find(
      (item) => item.clientId === photo.item.clientId,
    );
    if (!target) throw new Error(`Photo ${photo.item.filename} was not staged`);
    const upload = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: { "content-type": photo.item.contentType },
      body: photo.bytes,
    });
    if (!upload.ok)
      throw new Error(`Photo upload ${upload.status}: ${await upload.text()}`);
    images.push({
      imageId: target.imageId,
      position: photo.position,
      sha256: photo.item.sha256,
      width: photo.item.width,
      height: photo.item.height,
    });
  }
  await post("finalize", { runId, images }, z.object({}).loose());
  return runId;
}

/**
 * A browser-synced vendor account with one finished sync, and the simulated
 * Mac browser serving its order history and one order by URL. The member
 * starts the account's next sync from that finished run.
 */
async function seedAccountSync(
  pool: Pool,
  memberId: LedgerPartyId,
  userId: string,
  services: CoupledServices,
) {
  const { sync } = LIVE_IMPORT;
  const db = buildScenarioDatabase(pool);
  const historyUrl = `https://${sync.host}/order-history`;
  const orderUrl = `https://${sync.host}/orders/details?orderID=${sync.orderId}`;
  const vendor = await insertWithShortcode(db, "vendor", {
    name: sync.vendor,
    website: historyUrl,
    browserDomains: [sync.host],
    orderEvidence: "online_account",
  });
  const account = await insertWithShortcode(db, "vendorAccount", {
    label: "Synthetic trowel account",
    vendorId: vendor.id,
    ledgerPartyId: memberId,
    browserSyncEnabled: true,
    browser: "chrome",
  });
  const prior = await startOrResumeRun(db, {
    ledgerPartyId: memberId,
    vendorAccountId: account.id,
    trigger: "manual",
  });
  await getDb(db)
    .update(runTable)
    .set({
      status: "completed",
      coordinatorStartedAt: new Date(),
      endedAt: new Date(),
      historyExhaustedAt: new Date(),
    })
    .where(eq(runTable.id, prior.id));
  const capture = (
    sourceURL: string,
    title: string,
    text: string,
    links: Array<{ url: string; label: string }>,
  ) => completedCapture(sourceURL, { title, text, links });
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const principal = sync.cents - 100;
  await services.connectBrowser({
    vendorAccountId: account.id,
    ledgerPartyId: memberId,
    userId,
    outcomes: {
      [historyUrl]: await capture(
        historyUrl,
        "Your Orders",
        `Your orders\nOrder placed September 20, 2026 Order # ${sync.orderId} Total ${dollars(sync.cents)}`,
        [{ url: orderUrl, label: "View order details" }],
      ),
      [orderUrl]: await capture(
        orderUrl,
        `Order ${sync.orderId}`,
        `Order ${sync.orderId} placed September 20, 2026. ${sync.item} (SKU TROWEL-1) qty 1 ${dollars(principal)}. Sales tax $1.00. Order total ${dollars(sync.cents)}.`,
        [],
      ),
    },
  });
  return { run: prior.publicId, vendor: vendor.shortcode };
}

/**
 * One Vendor with a saved itemized confirmation (a product link on the
 * Vendor's own site in its HTML) and a shipping notice for the same order.
 * `synced` gives the member a browser-synced account, so the import's new
 * Product starts follow-up enrichment; otherwise the import creates the
 * member's mail-only account itself.
 */
async function seedSavedConfirmation(
  db: ReturnType<typeof buildScenarioDatabase>,
  memberId: string,
  source: (typeof LIVE_IMPORT)["mail" | "enrich"] & { synced: boolean },
) {
  const party = parseEntityId("ledgerParty", memberId);
  const vendor = await insertWithShortcode(db, "vendor", {
    name: source.vendor,
    website: `https://${source.host}`,
    browserDomains: [source.host],
  });
  if (source.synced)
    await insertWithShortcode(db, "vendorAccount", {
      label: source.vendor,
      vendorId: vendor.id,
      ledgerPartyId: party,
    });
  const save = async (
    event: "placed" | "shipped",
    receivedAt: string,
    content: { bodyHtml: string | null; bodyText: string },
  ) => {
    const [saved] = await getDb(db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party,
        vendorId: vendor.id,
        messageId: `synthetic-live-${event}-${crypto.randomUUID()}`,
        sender: `orders@${source.host}`,
        subject: `Synthetic order ${event}`,
        receivedAt: new Date(receivedAt),
        rawChecksum: createHash("sha256")
          .update(`${source.orderId}:${event}`)
          .digest("hex"),
        content: { snippet: null, ...content },
      })
      .returning();
    if (!saved) throw new Error(`Synthetic ${event} mail was not saved`);
    await getDb(db)
      .insert(orderMailEvent)
      .values({
        orderMailId: saved.id,
        event,
        orderId: source.orderId,
        amount: event === "placed" ? source.cents / 100 : null,
        currency: "USD",
        sourceKey: `synthetic:${saved.id}`,
      });
  };
  await save("placed", "2026-09-10T15:00:00Z", {
    bodyHtml: `<p>Order ${source.orderId}</p><table><tr><td><a href="${source.productUrl}">${source.item}</a></td><td>SKU HERB-1</td><td>1</td><td>$5.00</td></tr></table><p>Grand total $5.00 USD</p>`,
    bodyText: `Order ${source.orderId}. ${source.item} (${source.productUrl}), SKU HERB-1, qty 1, $5.00. Grand total $5.00 USD.`,
  });
  await save("shipped", "2026-09-11T15:00:00Z", {
    bodyHtml: null,
    bodyText: `Your order ${source.orderId} has shipped.`,
  });
  return { vendor: vendor.shortcode };
}
