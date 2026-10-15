import { describe, expect, it } from "vitest";

import { extractImageMetadata } from "./image-metadata";

// ---------------------------------------------------------------------------
// A tiny, from-scratch TIFF/EXIF encoder — the mirror image of the reader
// under test. Builds a minimal but spec-correct little-endian TIFF blob with
// an optional Exif sub-IFD and GPS sub-IFD, then wraps it in a synthetic
// JPEG (APP1) or PNG (`eXIf` chunk) container. No real photo bytes are used
// or needed.
// ---------------------------------------------------------------------------

interface RawField {
  tag: number;
  type: number;
  count: number;
  data: Uint8Array;
}

const u16le = (n: number): Uint8Array => {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, n, true);
  return bytes;
};
const u32le = (n: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, n, true);
  return bytes;
};
const asciiField = (value: string): Uint8Array =>
  new TextEncoder().encode(`${value}\0`);
const rational = (numerator: number, denominator: number): Uint8Array => {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, numerator, true);
  view.setUint32(4, denominator, true);
  return bytes;
};

const shortField = (tag: number, value: number): RawField => ({
  tag,
  type: 3,
  count: 1,
  data: u16le(value),
});
const longField = (tag: number, value: number): RawField => ({
  tag,
  type: 4,
  count: 1,
  data: u32le(value),
});
const asciiFieldEntry = (tag: number, value: string): RawField => {
  const data = asciiField(value);
  return { tag, type: 2, count: data.length, data };
};
const byteField = (tag: number, value: number): RawField => ({
  tag,
  type: 1,
  count: 1,
  data: new Uint8Array([value]),
});
const rationalField = (
  tag: number,
  values: readonly [number, number][],
): RawField => {
  const data = new Uint8Array(values.length * 8);
  values.forEach(([n, d], index) => data.set(rational(n, d), index * 8));
  return { tag, type: 5, count: values.length, data };
};

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Lays out one IFD's header at `ifdStart`, spilling any field whose value is
 * over 4 bytes into a pool starting at `poolStart`. Returns the header bytes,
 * the pool bytes, and where the next IFD's pool may start. */
function buildIfd(fields: readonly RawField[], poolStart: number) {
  let poolCursor = poolStart;
  const offsets = fields.map((field) => {
    if (field.data.length <= 4) return -1;
    const offset = poolCursor;
    poolCursor += field.data.length + (field.data.length % 2);
    return offset;
  });

  const header: number[] = [];
  header.push(...u16le(fields.length));
  fields.forEach((field, index) => {
    header.push(
      ...u16le(field.tag),
      ...u16le(field.type),
      ...u32le(field.count),
    );
    if (field.data.length <= 4) {
      const inline = new Uint8Array(4);
      inline.set(field.data);
      header.push(...inline);
    } else {
      header.push(...u32le(offsets[index]!));
    }
  });
  header.push(...u32le(0)); // next-IFD offset: none

  const poolChunks = fields
    .filter((field) => field.data.length > 4)
    .map((field) =>
      field.data.length % 2 === 1
        ? concatBytes([field.data, new Uint8Array(1)])
        : field.data,
    );

  return {
    header: new Uint8Array(header),
    pool: concatBytes(poolChunks),
    nextPoolStart: poolCursor,
  };
}

/** Byte size of an IFD header with this many entries (count + entries + next-IFD offset). */
const ifdHeaderSize = (entryCount: number): number => 2 + entryCount * 12 + 4;

const EMPTY_BLOCK = {
  header: new Uint8Array(0),
  pool: new Uint8Array(0),
  nextPoolStart: -1,
};

/** Builds a full little-endian TIFF blob (relative offsets from byte 0) with
 * IFD0, and optional Exif/GPS sub-IFDs threaded in via their pointer tags. */
function buildTiff(
  ifd0Fields: readonly RawField[],
  exifFields: readonly RawField[] = [],
  gpsFields: readonly RawField[] = [],
): Uint8Array {
  const IFD0_START = 8;
  const hasExif = exifFields.length > 0;
  const hasGps = gpsFields.length > 0;
  const ifd0EntryCount =
    ifd0Fields.length + (hasExif ? 1 : 0) + (hasGps ? 1 : 0);
  const exifStart = IFD0_START + ifdHeaderSize(ifd0EntryCount);
  const gpsStart = exifStart + (hasExif ? ifdHeaderSize(exifFields.length) : 0);
  const poolStart = gpsStart + (hasGps ? ifdHeaderSize(gpsFields.length) : 0);

  const pointerFields = [
    ...(hasExif ? [longField(0x8769, exifStart)] : []),
    ...(hasGps ? [longField(0x8825, gpsStart)] : []),
  ];
  const ifd0Block = buildIfd([...ifd0Fields, ...pointerFields], poolStart);
  const exifBlock = hasExif
    ? buildIfd(exifFields, ifd0Block.nextPoolStart)
    : EMPTY_BLOCK;
  const gpsBlock = hasGps
    ? buildIfd(
        gpsFields,
        hasExif ? exifBlock.nextPoolStart : ifd0Block.nextPoolStart,
      )
    : EMPTY_BLOCK;

  const header = concatBytes([
    new TextEncoder().encode("II"),
    u16le(42),
    u32le(IFD0_START),
  ]);

  return concatBytes([
    header,
    ifd0Block.header,
    exifBlock.header,
    gpsBlock.header,
    ifd0Block.pool,
    exifBlock.pool,
    gpsBlock.pool,
  ]);
}

function wrapInJpeg(tiff: Uint8Array): Uint8Array {
  const exifSignature = concatBytes([
    new TextEncoder().encode("Exif"),
    new Uint8Array([0, 0]),
  ]);
  const segment = concatBytes([exifSignature, tiff]);
  const length = segment.length + 2;
  return concatBytes([
    new Uint8Array([0xff, 0xd8]), // SOI
    new Uint8Array([0xff, 0xe1]), // APP1
    new Uint8Array([(length >> 8) & 0xff, length & 0xff]),
    segment,
    new Uint8Array([0xff, 0xd9]), // EOI
  ]);
}

function wrapInPng(tiff: Uint8Array): Uint8Array {
  const signature = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, tiff.length, false);
  const type = new TextEncoder().encode("eXIf");
  const crc = new Uint8Array(4); // unvalidated by the reader under test
  return concatBytes([signature, length, type, tiff, crc]);
}

// ---------------------------------------------------------------------------

describe("extractImageMetadata", () => {
  it("reads DateTimeOriginal + OffsetTimeOriginal, camera fields, and GPS from a JPEG APP1 segment", () => {
    const tiff = buildTiff(
      [
        asciiFieldEntry(0x010f, "Apple"), // Make
        asciiFieldEntry(0x0110, "iPhone 15 Pro"), // Model
        asciiFieldEntry(0x0131, "18.2"), // Software
        shortField(0x0112, 6), // Orientation
      ],
      [
        asciiFieldEntry(0x9003, "2024:03:15 10:30:00"), // DateTimeOriginal
        asciiFieldEntry(0x9011, "-07:00"), // OffsetTimeOriginal
        asciiFieldEntry(0xa434, "iPhone 15 Pro back camera"), // LensModel
      ],
      [
        asciiFieldEntry(1, "N"), // GPSLatitudeRef
        rationalField(2, [
          [37, 1],
          [0, 1],
          [0, 1],
        ]), // GPSLatitude
        asciiFieldEntry(3, "W"), // GPSLongitudeRef
        rationalField(4, [
          [122, 1],
          [0, 1],
          [0, 1],
        ]), // GPSLongitude
        byteField(5, 0), // GPSAltitudeRef: above sea level
        rationalField(6, [[10, 1]]), // GPSAltitude
      ],
    );

    const result = extractImageMetadata(wrapInJpeg(tiff), "image/jpeg");

    expect(result).not.toBeNull();
    expect(result?.capturedAt?.toISOString()).toBe("2024-03-15T17:30:00.000Z");
    expect(result?.capturedAtOffsetMinutes).toBe(-420);
    expect(result?.location).toEqual({ lat: 37, lng: -122, altitude: 10 });
    expect(result?.camera).toEqual({
      make: "Apple",
      model: "iPhone 15 Pro",
      lens: "iPhone 15 Pro back camera",
      software: "18.2",
    });
    expect(result?.orientation).toBe(6);
  });

  it("negates GPS coordinates for S/W reference letters", () => {
    const tiff = buildTiff(
      [],
      [],
      [
        asciiFieldEntry(1, "S"), // GPSLatitudeRef
        rationalField(2, [
          [33, 1],
          [0, 1],
          [0, 1],
        ]),
        asciiFieldEntry(3, "W"), // GPSLongitudeRef
        rationalField(4, [
          [151, 1],
          [0, 1],
          [0, 1],
        ]),
      ],
    );

    const result = extractImageMetadata(wrapInJpeg(tiff), "image/jpeg");

    expect(result?.location).toEqual({ lat: -33, lng: -151 });
  });

  it("returns a capturedAt with no offset when OffsetTimeOriginal is absent", () => {
    const tiff = buildTiff(
      [],
      [asciiFieldEntry(0x9003, "2023:01:01 00:00:00")],
      [],
    );

    const result = extractImageMetadata(wrapInJpeg(tiff), "image/jpeg");

    expect(result?.capturedAt?.toISOString()).toBe("2023-01-01T00:00:00.000Z");
    expect(result?.capturedAtOffsetMinutes).toBeNull();
  });

  it("returns null for a JPEG stripped of its EXIF segment", () => {
    const stripped = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // bare SOI/EOI
    expect(extractImageMetadata(stripped, "image/jpeg")).toBeNull();
  });

  it("reads EXIF from a PNG eXIf chunk", () => {
    const tiff = buildTiff([asciiFieldEntry(0x010f, "Canon")]);
    const result = extractImageMetadata(wrapInPng(tiff), "image/png");
    expect(result?.camera).toEqual({ make: "Canon" });
  });

  it("returns null for a PNG with no eXIf chunk", () => {
    const signature = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(extractImageMetadata(signature, "image/png")).toBeNull();
  });

  it("returns null for an unsupported content type", () => {
    const tiff = buildTiff([asciiFieldEntry(0x010f, "Canon")]);
    expect(
      extractImageMetadata(wrapInJpeg(tiff), "application/pdf"),
    ).toBeNull();
  });

  it("never throws on truncated/garbage bytes", () => {
    const garbage = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2, 3,
    ]);
    expect(() => extractImageMetadata(garbage, "image/jpeg")).not.toThrow();
    expect(extractImageMetadata(garbage, "image/jpeg")).toBeNull();
  });
});
