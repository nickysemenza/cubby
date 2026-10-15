import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import type { Pool } from "pg";
import { and, eq, inArray } from "drizzle-orm";
import { pollUntil } from "@cubby/shared/retry";
import { APPLE_APP_IDENTITIES } from "@cubby/shared/apple-app-identity";
import { z } from "zod";
import { testUserId } from "@cubby/schemas/testing";
import { imageId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import * as schema from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  listPhotoGroupProposals,
  listPhotoRunImages,
  proposePhotoGroups,
} from "~/server/domains/photo-import/repo/run/proposals";
import { listImageSightings } from "~/server/domains/image/repo/image";
import { updateImageProcessingSettings } from "~/server/domains/image-processing/service/image-processing-maintenance";
import {
  completeDescribeImageJobs,
  listDescribeImageJobs,
} from "../convergence-harness";
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

// Each synthetic garment illustration has a distinct pixel pattern, not merely different
// file bytes; otherwise within-batch perceptual dedup requires 24 separate decisions.
function syntheticPhotoPNG(index: number, batchIdentity: string): Buffer {
  const size = 256;
  let seed = ((index + 1) * 2654435761) >>> 0;
  const shades = Array.from({ length: 64 }, () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return 32 + ((seed >>> 0) % 192);
  });
  const pixels = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const garment =
        (x >= 80 && x < 176 && y >= 66 && y < 222) ||
        (y >= 66 && y < 112 && x >= 40 && x < 216);
      const shade = shades[Math.floor(y / 32) * 8 + Math.floor(x / 32)];
      if (shade === undefined)
        throw new Error(
          "Synthetic photo pattern index exceeds its 8 by 8 palette",
        );
      const color = garment
        ? [45 + index * 5, 70 + index * 3, 100 + index * 2]
        : [shade, shade, shade];
      const offset = y * (size * 3 + 1) + 1 + x * 3;
      pixels.set(color, offset);
    }
  }
  const chunk = (kind: string, payload: Buffer): Buffer => {
    const contents = Buffer.concat([Buffer.from(kind), payload]);
    let crc = 0xffffffff;
    for (const byte of contents) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, contents, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("tEXt", Buffer.from(`SyntheticBatch\0${batchIdentity}`)),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Files and the authorized Photos Library are synthetic inputs. CSV and image stage/PUT/finalize,
 * proposed-group review and approval all execute in the installed iOS app. */
export async function createSimulatorInputJourney(input: {
  pool: Pool;
  userId: string;
  repoRoot: string;
  artifacts: string;
  deviceID: string;
  session: string;
  common: string[];
  agentDeviceCommand?: string;
  photoOnly?: boolean;
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
  writeFileSync(
    csv,
    "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Id\n2026-09-12,Synthetic Input Outfitters,Clothing,Synthetic Input Card,SYNTHETIC INPUT ORDER,,-42.50,synthetic-input-posted\n",
  );
  const imageInputs = Array.from({ length: 25 }, (_, index) => {
    const filename = path.join(inputs, `synthetic-input-shirt-${index}.png`);
    writeFileSync(
      filename,
      syntheticPhotoPNG(index, path.basename(input.artifacts)),
    );
    return filename;
  });
  const digests = new Set(
    imageInputs.map((filename) =>
      createHash("sha256").update(readFileSync(filename)).digest("hex"),
    ),
  );
  const replay = async (script: string, extension: "ad" | "yaml" = "ad") => {
    const report = path.join(input.artifacts, `${script}.json`);
    // Suite test creates a new runner owner; these phases share the prepared session.
    await input.run(
      input.agentDeviceCommand ?? "pnpm",
      [
        ...(input.agentDeviceCommand ? [] : ["exec", "agent-device"]),
        "replay",
        `apps/apple/e2e/${script}.${extension}`,
        ...(extension === "yaml" ? ["--maestro"] : []),
        ...input.common,
        "--timeout",
        "600000",
        "--json",
      ],
      report,
    );
    const result = z
      .object({
        success: z.literal(true),
        data: z.object({
          replayed: z.number().int().positive(),
          healed: z.literal(0),
          sessionActive: z.literal(true),
          session: z.literal(input.session),
        }),
      })
      .parse(JSON.parse(readFileSync(report, "utf8")));
    console.log(
      `[native-replay] ${script} passed ${result.data.replayed} actions`,
    );
  };
  const selectNewestPhotoBatch = async () => {
    const snapshotSchema = z.object({
      success: z.literal(true),
      data: z.object({
        viewport: z.object({ height: z.number() }),
        nodes: z.array(
          z.object({
            ref: z.string(),
            label: z.string().optional(),
            identifier: z.string().optional(),
            kind: z.string().optional(),
            value: z.string().optional(),
            selected: z.boolean().optional(),
            hittable: z.boolean().optional(),
            rect: z.object({
              x: z.number(),
              y: z.number(),
              width: z.number(),
              height: z.number(),
            }),
          }),
        ),
      }),
    });
    await input.run(
      input.agentDeviceCommand ?? "pnpm",
      [
        ...(input.agentDeviceCommand ? [] : ["exec", "agent-device"]),
        "scroll",
        "top",
        ...input.common,
        "--json",
      ],
      path.join(input.artifacts, "photo-selection-top.json"),
    );
    let selected = 0;
    for (let step = 0; step < 80; step++) {
      const report = path.join(input.artifacts, `photo-selection-${step}.json`);
      await input.run(
        input.agentDeviceCommand ?? "pnpm",
        [
          ...(input.agentDeviceCommand ? [] : ["exec", "agent-device"]),
          "snapshot",
          ...input.common,
          "--json",
        ],
        report,
      );
      const snapshot = snapshotSchema.parse(
        JSON.parse(readFileSync(report, "utf8")),
      ).data;
      const tiles = snapshot.nodes
        .filter(
          (node) =>
            node.kind === "button" &&
            node.identifier !== "photos.grid.details" &&
            node.rect.width >= 80 &&
            node.rect.height >= 80,
        )
        .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
      const count = snapshot.nodes
        .map((node) => node.label?.match(/^(\d+) selected$/)?.[1])
        .find((value) => value !== undefined);
      if (Number(count ?? 0) !== selected)
        throw new Error(
          "Photos Library selection did not acknowledge the previous observed tile",
        );
      if (selected === 25) {
        if (!snapshot.nodes.some((node) => node.label === "25 selected"))
          throw new Error(
            "Photos Library did not confirm exactly 25 selected photos",
          );
        console.log(
          "[native-photos] selected newest25 using fresh snapshot refs",
        );
        return;
      }
      const tile = tiles.find(
        (node) =>
          !node.value?.startsWith("Selected photo") &&
          node.hittable &&
          node.rect.y + node.rect.height / 2 >= 315 &&
          node.rect.y + node.rect.height / 2 < snapshot.viewport.height - 150,
      );
      const command = tile
        ? ["click", `@${tile.ref}`]
        : ["scroll", "down", "0.15"];
      await input.run(
        input.agentDeviceCommand ?? "pnpm",
        [
          ...(input.agentDeviceCommand ? [] : ["exec", "agent-device"]),
          ...command,
          ...input.common,
          "--json",
        ],
        path.join(input.artifacts, `photo-selection-action-${step}.json`),
      );
      if (tile) selected++;
    }
    throw new Error(
      "Could not select all 25 newest synthetic photos using observed refs",
    );
  };
  return {
    inputs: [csv, ...imageInputs],
    async installInputs(appDocuments: string) {
      await input.run("xcrun", [
        "simctl",
        "privacy",
        input.deviceID,
        "grant",
        "photos",
        APPLE_APP_IDENTITIES.production.bundleIdentifier,
      ]);
      mkdirSync(appDocuments, { recursive: true });
      copyFileSync(csv, path.join(appDocuments, path.basename(csv)));
      await input.run("xcrun", [
        "simctl",
        "addmedia",
        input.deviceID,
        ...imageInputs,
      ]);
    },
    async execute() {
      let transaction: string | null = null;
      if (!input.photoOnly) {
        await replay("input-statement-open");
        await replay("input-statement-files", "yaml");
        await replay("input-statement");
        const transactions = await database.query.financialTransaction.findMany(
          {
            where: notDeleted(schema.financialTransaction),
          },
        );
        if (transactions.length !== 1 || transactions[0]?.amount !== 42.5)
          throw new Error(
            "Native CSV decision did not create exactly the reviewed transaction",
          );
        transaction = transactions[0].shortcode;
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
      }
      await replay("input-photo-open");
      await selectNewestPhotoBatch();
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
        return result.length === 25 ? result : undefined;
      }, "native stage/PUT/finalize");
      const stored = await database.query.image.findMany({
        where: inArray(
          schema.image.shortcode,
          images.map((image) => image.id),
        ),
      });
      if (
        stored.length !== 25 ||
        stored.some((image) => !image.sha256 || !digests.has(image.sha256))
      )
        throw new Error("Native Photos input original digest changed");
      if (stored.some((image) => image.capturedAt === null))
        throw new Error(
          "Native PhotosLibrary input lost its Capture date before optional analysis",
        );
      const sightings = await listImageSightings(
        db,
        stored.map((image) => image.id),
      );
      const sightedImages = stored.filter((image) =>
        sightings
          .get(image.id)
          ?.some(
            (sighting) =>
              sighting.matchKind === "import" &&
              sighting.capturedAt !== null &&
              sighting.assetKey.length > 0,
          ),
      );
      if (sightedImages.length !== 25)
        throw new Error(
          `Native PhotosLibrary import retained ${sightedImages.length} of 25 capture-date Sightings`,
        );
      const jobs = await eventually(async () => {
        const found = await listDescribeImageJobs(
          db,
          stored.map((image) => imageId.parse(image.id)),
        );
        const states = new Map<string, number>();
        for (const job of found) {
          const key = `${job.processorRevision}:${job.state}`;
          states.set(key, (states.get(key) ?? 0) + 1);
        }
        const coveredImages = new Set(found.map((job) => job.imageId)).size;
        writeFileSync(
          path.join(input.artifacts, "native-cloud-description-jobs.json"),
          JSON.stringify(
            {
              expectedImages: 25,
              cloudJobCount: found.length,
              coveredImages,
              revisionStates: Object.fromEntries(states),
            },
            null,
            2,
          ),
        );
        return found.length === 25 && coveredImages === 25 ? found : undefined;
      }, "native finalization cloud description jobs");
      await completeDescribeImageJobs(
        db,
        jobs,
        "Supplied synthetic model response: distinct synthetic crew-shirt illustrations.",
      );
      await proposePhotoGroups(db, {
        runId: parseShortcodeFor("run", run.shortcode),
        groups: [
          {
            groupKey: "synthetic-input-shirt",
            images: images.map((image) => ({
              id: image.id,
              purpose: "item" as const,
            })),
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
      const expenses = await database.query.expense.findMany({
        where: notDeleted(schema.expense),
      });
      const inventory = await database.query.inventoryEntry.findMany({
        where: notDeleted(schema.inventoryEntry),
      });
      if (expenses.length || inventory.length)
        throw new Error(
          "Native photo import or approval auto-booked Expense or Inventory",
        );
      if (
        input.photoOnly &&
        (
          await database.query.financialTransaction.findMany({
            where: notDeleted(schema.financialTransaction),
          })
        ).length
      )
        throw new Error(
          "Photo-only intake auto-booked a financial transaction",
        );
      const evidence = path.join(input.artifacts, "native-input-result.json");
      writeFileSync(
        evidence,
        JSON.stringify(
          {
            account: input.photoOnly ? null : card.id,
            transaction,
            photoRun: run.shortcode,
            imageSha256s: [...digests].sort(),
            photoCount: images.length,
            captureDateCount: stored.filter(
              (image) => image.capturedAt !== null,
            ).length,
            sightedImageCount: sightedImages.length,
            products: products.length,
            expenseAutoWrites: 0,
            inventoryAutoWrites: 0,
            input: input.photoOnly
              ? "actual authorized Photos Library grid"
              : "actual Files CSV + authorized Photos Library grid",
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
