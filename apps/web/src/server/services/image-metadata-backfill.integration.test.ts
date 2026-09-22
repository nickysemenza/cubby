import { parseEntityId } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createDevice } from "~/server/repo/device";
import {
  getImageById,
  getImageMetadataExtractionRow,
} from "~/server/repo/image";
import { applyImageMetadataExtraction } from "~/server/repo/image-metadata";
import { createImageSighting } from "~/server/repo/image-sighting";
import { createLedgerParty } from "~/server/repo/ledger-party";
import { createImageFixture } from "~/server/repo/repo.fixtures";
import { extractImageMetadata } from "~/server/services/image-metadata";
import { backfillImageMetadata } from "~/server/services/image-metadata-backfill.service";
import {
  extractAndStoreImageMetadata,
  type ExtractImageMetadataPorts,
} from "~/server/services/image-metadata-extraction.service";

// ---------------------------------------------------------------------------
// A minimal synthetic JPEG carrying DateTimeOriginal + GPS — enough to drive
// the real extraction/derivation wiring without touching R2. See
// `image-metadata.unit.test.ts` for the full from-scratch TIFF encoder this
// mirrors a slice of.
// ---------------------------------------------------------------------------

const u16le = (n: number): Uint8Array => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
};
const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const asciiField = (v: string): Uint8Array =>
  new TextEncoder().encode(`${v}\0`);
const rational = (n: number, d: number): Uint8Array => {
  const b = new Uint8Array(8);
  const view = new DataView(b.buffer);
  view.setUint32(0, n, true);
  view.setUint32(4, d, true);
  return b;
};
interface Field {
  tag: number;
  type: number;
  count: number;
  data: Uint8Array;
}
const asciiEntry = (tag: number, v: string): Field => {
  const data = asciiField(v);
  return { tag, type: 2, count: data.length, data };
};
const rationalEntry = (tag: number, values: [number, number][]): Field => {
  const data = new Uint8Array(values.length * 8);
  values.forEach(([n, d], i) => data.set(rational(n, d), i * 8));
  return { tag, type: 5, count: values.length, data };
};
const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
};

function buildIfd(fields: Field[], poolStart: number) {
  let cursor = poolStart;
  const offsets = fields.map((f) => {
    if (f.data.length <= 4) return -1;
    const o = cursor;
    cursor += f.data.length + (f.data.length % 2);
    return o;
  });
  const header: number[] = [...u16le(fields.length)];
  fields.forEach((f, i) => {
    header.push(...u16le(f.tag), ...u16le(f.type), ...u32le(f.count));
    if (f.data.length <= 4) {
      const inline = new Uint8Array(4);
      inline.set(f.data);
      header.push(...inline);
    } else {
      header.push(...u32le(offsets[i]!));
    }
  });
  header.push(...u32le(0));
  const pool = concat(
    fields
      .filter((f) => f.data.length > 4)
      .map((f) =>
        f.data.length % 2 === 1 ? concat([f.data, new Uint8Array(1)]) : f.data,
      ),
  );
  return { header: new Uint8Array(header), pool, nextPoolStart: cursor };
}

function buildJpegWithExif(
  dateTime: string,
  lat: number,
  lng: number,
): Uint8Array {
  const exifFields = [asciiEntry(0x9003, dateTime)];
  const gpsFields = [
    asciiEntry(1, lat >= 0 ? "N" : "S"),
    rationalEntry(2, [
      [Math.abs(lat), 1],
      [0, 1],
      [0, 1],
    ]),
    asciiEntry(3, lng >= 0 ? "E" : "W"),
    rationalEntry(4, [
      [Math.abs(lng), 1],
      [0, 1],
      [0, 1],
    ]),
  ];
  const IFD0_START = 8;
  const ifd0EntryCount = 2; // ExifIFD pointer + GPSIFD pointer
  const ifd0Size = 2 + ifd0EntryCount * 12 + 4;
  const exifStart = IFD0_START + ifd0Size;
  const exifSize = 2 + exifFields.length * 12 + 4;
  const gpsStart = exifStart + exifSize;
  const gpsSize = 2 + gpsFields.length * 12 + 4;
  const poolStart = gpsStart + gpsSize;

  const ifd0Full = [
    { tag: 0x8769, type: 4, count: 1, data: u32le(exifStart) },
    { tag: 0x8825, type: 4, count: 1, data: u32le(gpsStart) },
  ];
  const ifd0Block = buildIfd(ifd0Full, poolStart);
  const exifBlock = buildIfd(exifFields, ifd0Block.nextPoolStart);
  const gpsBlock = buildIfd(gpsFields, exifBlock.nextPoolStart);
  const header = concat([
    new TextEncoder().encode("II"),
    u16le(42),
    u32le(IFD0_START),
  ]);
  const tiff = concat([
    header,
    ifd0Block.header,
    exifBlock.header,
    gpsBlock.header,
    ifd0Block.pool,
    exifBlock.pool,
    gpsBlock.pool,
  ]);

  const exifSignature = concat([
    new TextEncoder().encode("Exif"),
    new Uint8Array([0, 0]),
  ]);
  const segment = concat([exifSignature, tiff]);
  const length = segment.length + 2;
  return concat([
    new Uint8Array([0xff, 0xd8]),
    new Uint8Array([0xff, 0xe1]),
    new Uint8Array([(length >> 8) & 0xff, length & 0xff]),
    segment,
    new Uint8Array([0xff, 0xd9]),
  ]);
}

const stubbedPorts = (bytes: Uint8Array): ExtractImageMetadataPorts => ({
  getRow: getImageMetadataExtractionRow,
  getBytes: async () => bytes,
  extract: extractImageMetadata,
  apply: applyImageMetadataExtraction,
});

describe("image metadata extraction + backfill (real Postgres)", () => {
  const ctx = withTestDb();

  it("advances the stale marker and derives capturedAt/location from EXIF when there is no sighting", async () => {
    const jpeg = buildJpegWithExif("2025:07:04 09:15:00", 40, -74);
    const image = await createImageFixture(ctx.db, "no-sighting", {
      contentType: "image/jpeg",
    });
    const imageId = parseEntityId("image", image.id);

    const outcome = await extractAndStoreImageMetadata(
      ctx.db,
      imageId,
      stubbedPorts(jpeg),
    );
    expect(outcome).toBe("succeeded");

    const row = await getImageById(ctx.db, image.id);
    expect(row.capturedAt?.toISOString()).toBe("2025-07-04T09:15:00.000Z");
    expect(row.captureLocation).toEqual({ lat: 40, lng: -74 });
    expect(row.capturedByPartyId).toBeNull();
    expect(row.provenanceEvidence).toEqual({ basis: "exif" });

    // Re-running against the now-fresh row is a no-op: the candidate WHERE
    // no longer matches it, so `getRow` returns nothing.
    const second = await extractAndStoreImageMetadata(
      ctx.db,
      imageId,
      stubbedPorts(jpeg),
    );
    expect(second).toBe("skipped");
  });

  it("keeps sighting-derived capture evidence when EXIF is also present (sighting outranks exif)", async () => {
    const jpeg = buildJpegWithExif("2025:01:01 00:00:00", 10, 10);
    const image = await createImageFixture(ctx.db, "with-sighting", {
      contentType: "image/jpeg",
    });
    const ana = await createLedgerParty(
      ctx.db,
      { name: "Ana", kind: "member", notes: null },
      ctx.actor,
    );
    const anaPhone = await createDevice(
      ctx.db,
      {
        installationId: crypto.randomUUID(),
        name: "Ana's Phone",
        platform: "ios",
        appVersion: null,
        osVersion: null,
        automaticWork: true,
        remotePaused: false,
        ledgerPartyId: ana.output.id,
      },
      ctx.actor,
    );
    await createImageSighting(
      ctx.db,
      {
        imageId: image.shortcode,
        ledgerPartyId: ana.output.id,
        deviceId: anaPhone.output.id,
        assetKey: "ASSET-1",
        sourceType: "userLibrary",
        mediaSubtypes: [],
        hasAdjustments: false,
        matchKind: "import",
        observedAt: new Date("2025-06-01T00:00:00Z"),
        capturedAt: new Date("2025-06-01T08:00:00Z"),
        location: { lat: 51.5, lng: -0.12 },
      },
      ctx.actor,
    );

    await extractAndStoreImageMetadata(
      ctx.db,
      parseEntityId("image", image.id),
      stubbedPorts(jpeg),
    );

    const row = await getImageById(ctx.db, image.id);
    // The sighting's own capture facts, not the EXIF blob's, win.
    expect(row.capturedAt?.toISOString()).toBe("2025-06-01T08:00:00.000Z");
    expect(row.captureLocation).toEqual({ lat: 51.5, lng: -0.12 });
    expect(row.captureAttribution).toBe("derived");
    expect(row.provenanceEvidence).toEqual({ basis: "sighting" });
  });

  it("backfillImageMetadata bounds a loop over every stale row and reports completion", async () => {
    const jpeg = buildJpegWithExif("2025:03:03 03:03:00", 0, 0);
    const images = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        createImageFixture(ctx.db, `backfill-${i}`, {
          contentType: "image/jpeg",
        }),
      ),
    );

    const result = await backfillImageMetadata(
      ctx.db,
      { batchSize: 2, maxBatches: 10 },
      {
        select: async (db, limit) => {
          const { selectImagesForMetadataExtraction } =
            await import("~/server/repo/image");
          return selectImagesForMetadataExtraction(db, limit);
        },
        count: async (db) => {
          const { countImagesStaleMetadata } =
            await import("~/server/repo/image");
          return countImagesStaleMetadata(db);
        },
        extract: (db, imageId) =>
          extractAndStoreImageMetadata(db, imageId, stubbedPorts(jpeg)),
      },
    );

    expect(result.stopped).toBe("complete");
    expect(result.extracted).toBeGreaterThanOrEqual(images.length);
    expect(result.remaining).toBe(0);

    for (const image of images) {
      const row = await getImageById(ctx.db, image.id);
      expect(row.capturedAt?.toISOString()).toBe("2025-03-03T03:03:00.000Z");
    }
  });
});
