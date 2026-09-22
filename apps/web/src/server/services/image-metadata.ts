import type { ImageCaptureLocation } from "@cubby/schemas/image-capture-fields";
import type { ImageSightingCamera } from "@cubby/schemas/image-sighting-fields";

/**
 * Embedded EXIF/GPS metadata read directly from an image's leading bytes —
 * the in-memory, `Date`-typed shape `extractImageMetadata` returns. Cached on
 * `Image.embeddedMetadata` as `StoredImageEmbeddedMetadata`
 * (`@cubby/schemas/image`), whose `capturedAt` is an ISO string: jsonb has no
 * Date type, so `image-metadata-extraction.service.ts` converts at the
 * storage boundary.
 */
export interface ImageEmbeddedMetadata {
  capturedAt: Date | null;
  capturedAtOffsetMinutes: number | null;
  location: ImageCaptureLocation | null;
  camera: ImageSightingCamera | null;
  orientation: number | null;
}

/**
 * A hand-rolled reader rather than the `exifr` npm package: `exifr`'s
 * ESM bundles (`full`/`lite`/`mini`) all reference Node's `fs`/`Buffer`/
 * `process` at module scope (verified against the published tarball), which
 * is unsafe to bundle for workerd. This parses only the container/TIFF
 * structure needed to locate a handful of tags — it never decodes pixels —
 * and every branch is defensive: a malformed or truncated container returns
 * `null` rather than throwing.
 */
const MAX_METADATA_READ_BYTES = 4 * 1024 * 1024;

const textDecoder = new TextDecoder("ascii");

const asciiAt = (bytes: Uint8Array, start: number, length: number): string =>
  start >= 0 && start + length <= bytes.length
    ? textDecoder.decode(bytes.subarray(start, start + length))
    : "";

// ---------------------------------------------------------------------------
// TIFF/EXIF primitives
// ---------------------------------------------------------------------------

type ByteOrder = "LE" | "BE";

interface TiffContext {
  view: DataView;
  order: ByteOrder;
  /** Absolute byte offset of the TIFF header ("II"/"MM") within `view`. */
  tiffStart: number;
}

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Absolute offset of this entry's value bytes within `view`. */
  valueOffset: number;
}

/** Byte size of one value of an EXIF/TIFF field type; 0 for an unknown type. */
const TYPE_SIZE = new Map<number, number>([
  [1, 1], // BYTE
  [2, 1], // ASCII
  [3, 2], // SHORT
  [4, 4], // LONG
  [5, 8], // RATIONAL
  [6, 1], // SBYTE
  [7, 1], // UNDEFINED
  [8, 2], // SSHORT
  [9, 4], // SLONG
  [10, 8], // SRATIONAL
  [11, 4], // FLOAT
  [12, 8], // DOUBLE
]);

const readUint16 = (ctx: TiffContext, offset: number): number | null =>
  offset + 2 <= ctx.view.byteLength
    ? ctx.view.getUint16(offset, ctx.order === "LE")
    : null;

const readUint32 = (ctx: TiffContext, offset: number): number | null =>
  offset + 4 <= ctx.view.byteLength
    ? ctx.view.getUint32(offset, ctx.order === "LE")
    : null;

const readInt32 = (ctx: TiffContext, offset: number): number | null =>
  offset + 4 <= ctx.view.byteLength
    ? ctx.view.getInt32(offset, ctx.order === "LE")
    : null;

/** Reads one IFD's entries at `ifdOffset` (relative to `tiffStart`). Bounded:
 * refuses an entry count that would run past the buffer, rather than reading
 * garbage. */
function readIfd(ctx: TiffContext, ifdOffset: number): Map<number, IfdEntry> {
  const entries = new Map<number, IfdEntry>();
  const absolute = ctx.tiffStart + ifdOffset;
  const entryCount = readUint16(ctx, absolute);
  if (entryCount === null) return entries;
  for (let index = 0; index < entryCount; index++) {
    const entryOffset = absolute + 2 + index * 12;
    if (entryOffset + 12 > ctx.view.byteLength) break;
    const tag = ctx.view.getUint16(entryOffset, ctx.order === "LE");
    const type = ctx.view.getUint16(entryOffset + 2, ctx.order === "LE");
    const count = ctx.view.getUint32(entryOffset + 4, ctx.order === "LE");
    const size = (TYPE_SIZE.get(type) ?? 0) * count;
    // A value that fits in 4 bytes is stored inline in the entry itself;
    // otherwise the 4 bytes are an offset (relative to `tiffStart`) to it.
    const valueOffset =
      size > 0 && size <= 4
        ? entryOffset + 8
        : ctx.tiffStart +
          ctx.view.getUint32(entryOffset + 8, ctx.order === "LE");
    entries.set(tag, { tag, type, count, valueOffset });
  }
  return entries;
}

/** ASCII string value, trimmed of the trailing NUL(s) TIFF strings carry. */
function readAscii(
  ctx: TiffContext,
  entry: IfdEntry | undefined,
): string | null {
  if (!entry || entry.type !== 2) return null;
  const raw = asciiAt(
    new Uint8Array(ctx.view.buffer, ctx.view.byteOffset),
    entry.valueOffset,
    entry.count,
  );
  const value = raw.replace(/\0+$/u, "").trim();
  return value.length > 0 ? value : null;
}

function readShort(
  ctx: TiffContext,
  entry: IfdEntry | undefined,
): number | null {
  if (!entry || (entry.type !== 3 && entry.type !== 8)) return null;
  return readUint16(ctx, entry.valueOffset);
}

function readByte(
  ctx: TiffContext,
  entry: IfdEntry | undefined,
): number | null {
  if (!entry) return null;
  return entry.valueOffset < ctx.view.byteLength
    ? ctx.view.getUint8(entry.valueOffset)
    : null;
}

function readLong(
  ctx: TiffContext,
  entry: IfdEntry | undefined,
): number | null {
  if (!entry) return null;
  if (entry.type === 3 || entry.type === 8) return readShort(ctx, entry);
  if (entry.type !== 4 && entry.type !== 9) return null;
  return readUint32(ctx, entry.valueOffset);
}

/** One RATIONAL (or SRATIONAL) at `index` within a (possibly multi-value)
 * entry. Returns `null` for a zero denominator rather than `Infinity`/`NaN`. */
function readRational(
  ctx: TiffContext,
  entry: IfdEntry | undefined,
  index: number,
): number | null {
  if (!entry || (entry.type !== 5 && entry.type !== 10) || index >= entry.count)
    return null;
  const base = entry.valueOffset + index * 8;
  const signed = entry.type === 10;
  const numerator = signed ? readInt32(ctx, base) : readUint32(ctx, base);
  const denominator = signed
    ? readInt32(ctx, base + 4)
    : readUint32(ctx, base + 4);
  if (numerator === null || denominator === null || denominator === 0)
    return null;
  return numerator / denominator;
}

// ---- EXIF tags ----
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_ORIENTATION = 0x0112;
const TAG_SOFTWARE = 0x0131;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TAG_LENS_MODEL = 0xa434;
const TAG_GPS_LAT_REF = 1;
const TAG_GPS_LAT = 2;
const TAG_GPS_LNG_REF = 3;
const TAG_GPS_LNG = 4;
const TAG_GPS_ALT_REF = 5;
const TAG_GPS_ALT = 6;

/** `"YYYY:MM:DD HH:MM:SS"` (EXIF's own format) plus an optional `"+HH:MM"`/
 * `"-HH:MM"` offset. Without an offset, the wall-clock value is treated as
 * UTC — the best a reader with no other signal can do; a device that embeds
 * `OffsetTimeOriginal` gets an exact instant. */
function parseExifDateTime(
  dateTime: string,
  offset: string | null,
): { capturedAt: Date; offsetMinutes: number | null } | null {
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(
    dateTime,
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  let offsetMinutes: number | null = null;
  if (offset) {
    const offsetMatch = /^([+-])(\d{2}):(\d{2})$/u.exec(offset);
    if (offsetMatch) {
      const [, sign, oh, om] = offsetMatch;
      offsetMinutes = (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om));
    }
  }
  const utcMillis =
    Date.UTC(year, month - 1, day, hour, minute, second) -
    (offsetMinutes ?? 0) * 60_000;
  return { capturedAt: new Date(utcMillis), offsetMinutes };
}

function readGpsCoordinate(
  ctx: TiffContext,
  gps: Map<number, IfdEntry>,
  valueTag: number,
  refTag: number,
  positiveRef: string,
): number | null {
  const entry = gps.get(valueTag);
  if (!entry) return null;
  const degrees = readRational(ctx, entry, 0);
  const minutes = readRational(ctx, entry, 1);
  const seconds = readRational(ctx, entry, 2);
  if (degrees === null) return null;
  const magnitude = degrees + (minutes ?? 0) / 60 + (seconds ?? 0) / 3600;
  const ref = readAscii(ctx, gps.get(refTag));
  return ref !== null && ref.toUpperCase() !== positiveRef
    ? -magnitude
    : magnitude;
}

/** Builds the `ImageSightingCamera` shape without ever assigning an
 * `undefined` field — each part is added only when the tag was present. */
function buildCamera(
  make: string | null,
  model: string | null,
  lens: string | null,
  software: string | null,
): ImageSightingCamera | null {
  if (!make && !model && !lens && !software) return null;
  const camera: ImageSightingCamera = {};
  if (make) camera.make = make;
  if (model) camera.model = model;
  if (lens) camera.lens = lens;
  if (software) camera.software = software;
  return camera;
}

interface ExifCapture {
  capturedAt: Date | null;
  capturedAtOffsetMinutes: number | null;
  lens: string | null;
}

/** DateTimeOriginal/OffsetTimeOriginal/LensModel from the Exif sub-IFD, if
 * IFD0 points to one. */
function readExifCapture(
  ctx: TiffContext,
  ifd0: Map<number, IfdEntry>,
): ExifCapture {
  const empty: ExifCapture = {
    capturedAt: null,
    capturedAtOffsetMinutes: null,
    lens: null,
  };
  const pointer = readLong(ctx, ifd0.get(TAG_EXIF_IFD));
  if (pointer === null) return empty;
  const exifIfd = readIfd(ctx, pointer);
  const dateTimeOriginal = readAscii(ctx, exifIfd.get(TAG_DATE_TIME_ORIGINAL));
  const offsetTimeOriginal = readAscii(
    ctx,
    exifIfd.get(TAG_OFFSET_TIME_ORIGINAL),
  );
  const lens = readAscii(ctx, exifIfd.get(TAG_LENS_MODEL));
  const parsed = dateTimeOriginal
    ? parseExifDateTime(dateTimeOriginal, offsetTimeOriginal)
    : null;
  return {
    capturedAt: parsed?.capturedAt ?? null,
    capturedAtOffsetMinutes: parsed?.offsetMinutes ?? null,
    lens,
  };
}

/** GPS location from the GPS sub-IFD, if IFD0 points to one. */
function readExifLocation(
  ctx: TiffContext,
  ifd0: Map<number, IfdEntry>,
): ImageCaptureLocation | null {
  const pointer = readLong(ctx, ifd0.get(TAG_GPS_IFD));
  if (pointer === null) return null;
  const gpsIfd = readIfd(ctx, pointer);
  const lat = readGpsCoordinate(ctx, gpsIfd, TAG_GPS_LAT, TAG_GPS_LAT_REF, "N");
  const lng = readGpsCoordinate(ctx, gpsIfd, TAG_GPS_LNG, TAG_GPS_LNG_REF, "E");
  if (lat === null || lng === null) return null;
  const altitudeRef = readByte(ctx, gpsIfd.get(TAG_GPS_ALT_REF));
  const altitudeMagnitude = readRational(ctx, gpsIfd.get(TAG_GPS_ALT), 0);
  if (altitudeMagnitude === null) return { lat, lng };
  const altitude = altitudeRef === 1 ? -altitudeMagnitude : altitudeMagnitude;
  return { lat, lng, altitude };
}

function parseTiff(
  bytes: Uint8Array,
  tiffStart: number,
): ImageEmbeddedMetadata | null {
  if (tiffStart + 8 > bytes.length) return null;
  const marker = asciiAt(bytes, tiffStart, 2);
  const order: ByteOrder | null =
    marker === "II" ? "LE" : marker === "MM" ? "BE" : null;
  if (!order) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ctx: TiffContext = { view, order, tiffStart };
  const magic = readUint16(ctx, tiffStart + 2);
  if (magic !== 42) return null;
  const ifd0Offset = readUint32(ctx, tiffStart + 4);
  if (ifd0Offset === null) return null;

  const ifd0 = readIfd(ctx, ifd0Offset);
  const make = readAscii(ctx, ifd0.get(TAG_MAKE));
  const model = readAscii(ctx, ifd0.get(TAG_MODEL));
  const software = readAscii(ctx, ifd0.get(TAG_SOFTWARE));
  const orientation = readShort(ctx, ifd0.get(TAG_ORIENTATION));

  const { capturedAt, capturedAtOffsetMinutes, lens } = readExifCapture(
    ctx,
    ifd0,
  );
  const location = readExifLocation(ctx, ifd0);
  const camera = buildCamera(make, model, lens, software);

  return { capturedAt, capturedAtOffsetMinutes, location, camera, orientation };
}

// ---------------------------------------------------------------------------
// Container extraction: locate the TIFF/EXIF byte range within each format
// ---------------------------------------------------------------------------

/** JPEG: scan APP markers for APP1 (`0xFFE1`) whose payload starts with the
 * `"Exif\0\0"` signature; the TIFF header follows immediately. Stops at the
 * start-of-scan marker (`0xFFDA`), where compressed image data begins. */
function findTiffStartInJpeg(bytes: Uint8Array): number | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // Markers with no payload: TEM, RSTn, SOI (already consumed); skip past
    // any fill bytes (0xFF00... is not valid here, but tolerate padding).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) break; // EOI
    if (offset + 4 > bytes.length) break;
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    if (marker === 0xe1) {
      const segmentStart = offset + 4;
      if (
        segmentStart + 6 <= bytes.length &&
        asciiAt(bytes, segmentStart, 4) === "Exif" &&
        bytes[segmentStart + 4] === 0 &&
        bytes[segmentStart + 5] === 0
      ) {
        return segmentStart + 6;
      }
    }
    if (marker === 0xda) break; // start of scan: compressed data follows
    if (length < 2) break; // malformed segment length; stop rather than loop
    offset += 2 + length;
  }
  return null;
}

/** PNG: the `eXIf` ancillary chunk holds a raw TIFF blob. Stops at `IDAT`
 * (image data), which a well-formed PNG never has EXIF after. */
function findTiffStartInPng(bytes: Uint8Array): number | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length < 8 ||
    !signature.every((byte, index) => bytes[index] === byte)
  )
    return null;
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(offset, false);
    const type = asciiAt(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    if (type === "eXIf") return dataStart;
    if (type === "IDAT" || dataStart + length + 4 > bytes.length) break;
    offset = dataStart + length + 4; // + 4-byte CRC
  }
  return null;
}

/** WebP: the `EXIF` RIFF chunk holds either a raw TIFF blob directly, or (as
 * some encoders write it) one prefixed with the same `"Exif\0\0"` signature
 * JPEG uses. */
function findTiffStartInWebp(bytes: Uint8Array): number | null {
  if (
    bytes.length < 12 ||
    asciiAt(bytes, 0, 4) !== "RIFF" ||
    asciiAt(bytes, 8, 4) !== "WEBP"
  )
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourCC = asciiAt(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (fourCC === "EXIF") {
      if (
        size >= 6 &&
        asciiAt(bytes, dataStart, 4) === "Exif" &&
        bytes[dataStart + 4] === 0 &&
        bytes[dataStart + 5] === 0
      )
        return dataStart + 6;
      return dataStart;
    }
    if (dataStart + size > bytes.length) break;
    offset = dataStart + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

interface IsobmffBox {
  type: string;
  /** Offset of this box's payload (after its size+type header). */
  payloadStart: number;
  /** Offset one past this box's last byte. */
  end: number;
}

/** Walks sibling ISOBMFF boxes in `[start, end)`. Handles the 64-bit
 * "largesize" extension; a `size === 0` box (extends to EOF) is left to the
 * caller by returning `end` as the file end, since only `meta` is walked
 * this way and a top-level `meta` box always has an explicit size in HEIF. */
function readBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
): IsobmffBox[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: IsobmffBox[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = view.getUint32(offset, false);
    const type = asciiAt(bytes, offset + 4, 4);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > end) break;
      const high = view.getUint32(offset + 8, false);
      const low = view.getUint32(offset + 12, false);
      size = high * 2 ** 32 + low;
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break;
    boxes.push({ type, payloadStart: offset + headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

/** One `infe` box: its item_ID if `item_type === "Exif"`, else `null`. */
function readInfeExifItemId(
  bytes: Uint8Array,
  view: DataView,
  infe: IsobmffBox,
): number | null {
  const infeVersion = bytes[infe.payloadStart];
  if (infeVersion === undefined || infeVersion < 2) return null;
  const idSize = infeVersion === 2 ? 2 : 4; // version 2: u16, version 3: u32
  const idOffset = infe.payloadStart + 4;
  if (idOffset + idSize + 4 > infe.end) return null;
  const itemId =
    idSize === 2
      ? view.getUint16(idOffset, false)
      : view.getUint32(idOffset, false);
  const itemType = asciiAt(bytes, idOffset + idSize + 2, 4);
  return itemType === "Exif" ? itemId : null;
}

/** `iinf`: the `item_ID` of the item whose `item_type` is `"Exif"`, or
 * `null` if there isn't one. */
function findExifItemId(
  bytes: Uint8Array,
  view: DataView,
  iinf: IsobmffBox,
): number | null {
  const iinfVersion = bytes[iinf.payloadStart];
  if (iinfVersion === undefined) return null;
  const entryCountSize = iinfVersion === 0 ? 2 : 4;
  const entryCountOffset = iinf.payloadStart + 4;
  if (entryCountOffset + entryCountSize > iinf.end) return null;
  const infeBoxes = readBoxes(
    bytes,
    entryCountOffset + entryCountSize,
    iinf.end,
  ).filter((box) => box.type === "infe");
  for (const infe of infeBoxes) {
    const itemId = readInfeExifItemId(bytes, view, infe);
    if (itemId !== null) return itemId;
  }
  return null;
}

interface IlocLayout {
  version: number;
  offsetSize: number;
  lengthSize: number;
  baseOffsetSize: number;
  indexSize: number;
  itemIdSize: number;
  itemCount: number;
  bodyStart: number;
}

/** `iloc`'s own header: per-field byte widths and where its item list
 * starts. See ISO/IEC 14496-12 `ItemLocationBox`. */
function readIlocLayout(
  bytes: Uint8Array,
  view: DataView,
  iloc: IsobmffBox,
): IlocLayout | null {
  const version = bytes[iloc.payloadStart];
  const sizesByte = bytes[iloc.payloadStart + 4];
  const baseOffsetSizeByte = bytes[iloc.payloadStart + 5];
  if (
    version === undefined ||
    sizesByte === undefined ||
    baseOffsetSizeByte === undefined
  )
    return null;
  const indexSize =
    version === 1 || version === 2 ? baseOffsetSizeByte & 0x0f : 0;
  const itemIdSize = version === 2 ? 4 : 2;
  const bodyStart = iloc.payloadStart + 6;
  if (bodyStart + itemIdSize > iloc.end) return null;
  const itemCount =
    itemIdSize === 2
      ? view.getUint16(bodyStart, false)
      : view.getUint32(bodyStart, false);
  return {
    version,
    offsetSize: sizesByte >> 4,
    lengthSize: sizesByte & 0x0f,
    baseOffsetSize: baseOffsetSizeByte >> 4,
    indexSize,
    itemIdSize,
    itemCount,
    bodyStart: bodyStart + itemIdSize,
  };
}

/** A big-endian, arbitrary-byte-width unsigned integer read that advances a
 * shared cursor — `iloc`'s field widths are per-file, not fixed. */
function readSizedAdvancing(
  bytes: Uint8Array,
  end: number,
  cursor: { pos: number },
  size: number,
): number | null {
  if (size === 0) return 0;
  if (cursor.pos + size > end) return null;
  let value = 0;
  for (let i = 0; i < size; i++)
    value = value * 256 + (bytes[cursor.pos + i] ?? 0);
  cursor.pos += size;
  return value;
}

/**
 * One `iloc` item entry: if it's the Exif item, returns the byte offset of
 * its first extent's data (`baseOffset + extentOffset`, before the 4-byte
 * TIFF-header-offset prefix every Exif item carries); otherwise `undefined`
 * (not this item — the caller continues) or `null` (malformed — the caller
 * gives up on the whole box).
 */
function readIlocItemExifDataStart(
  bytes: Uint8Array,
  view: DataView,
  iloc: IsobmffBox,
  layout: IlocLayout,
  cursor: { pos: number },
  exifItemId: number,
): number | null | undefined {
  if (cursor.pos + layout.itemIdSize > iloc.end) return null;
  const itemId =
    layout.itemIdSize === 2
      ? view.getUint16(cursor.pos, false)
      : view.getUint32(cursor.pos, false);
  cursor.pos += layout.itemIdSize;
  if (layout.version === 1 || layout.version === 2) cursor.pos += 2; // reserved(12) + construction_method(4)
  cursor.pos += 2; // data_reference_index
  const baseOffset = readSizedAdvancing(
    bytes,
    iloc.end,
    cursor,
    layout.baseOffsetSize,
  );
  if (baseOffset === null) return null;
  if (cursor.pos + 2 > iloc.end) return null;
  const extentCount = view.getUint16(cursor.pos, false);
  cursor.pos += 2;
  let firstExtentDataStart: number | undefined;
  for (let e = 0; e < extentCount; e++) {
    if (
      (layout.version === 1 || layout.version === 2) &&
      layout.indexSize > 0
    ) {
      if (
        readSizedAdvancing(bytes, iloc.end, cursor, layout.indexSize) === null
      )
        return null;
    }
    const extentOffset = readSizedAdvancing(
      bytes,
      iloc.end,
      cursor,
      layout.offsetSize,
    );
    const extentLength = readSizedAdvancing(
      bytes,
      iloc.end,
      cursor,
      layout.lengthSize,
    );
    if (extentOffset === null || extentLength === null) return null;
    if (itemId === exifItemId && e === 0)
      firstExtentDataStart = baseOffset + extentOffset;
  }
  return itemId === exifItemId ? (firstExtentDataStart ?? null) : undefined;
}

/** `iloc`: the Exif item's data start (before its 4-byte TIFF-offset
 * prefix), or `null` if it isn't resolvable. */
function findExifDataStart(
  bytes: Uint8Array,
  view: DataView,
  iloc: IsobmffBox,
  exifItemId: number,
): number | null {
  const layout = readIlocLayout(bytes, view, iloc);
  if (!layout) return null;
  const cursor = { pos: layout.bodyStart };
  for (let i = 0; i < layout.itemCount; i++) {
    const result = readIlocItemExifDataStart(
      bytes,
      view,
      iloc,
      layout,
      cursor,
      exifItemId,
    );
    if (result === null) return null; // malformed — give up
    if (result !== undefined) return result; // found
  }
  return null;
}

/**
 * HEIC/HEIF (ISOBMFF): `meta` → `iinf` (find the item whose `item_type` is
 * `"Exif"`, note its `item_ID`) → `iloc` (map that item id to a file offset
 * and length). The Exif item's own data begins with a 4-byte big-endian
 * "TIFF header offset" (`exif_tiff_header_offset`, HEIF's own framing) that
 * is skipped to reach the TIFF header itself. Every step is best-effort —
 * this is a small, defensive subset of ISOBMFF, not a general parser, and any
 * unexpected shape returns `null` rather than throwing.
 */
function findTiffStartInHeic(bytes: Uint8Array): number | null {
  if (bytes.length < 12 || asciiAt(bytes, 4, 4) !== "ftyp") return null;
  const brand = asciiAt(bytes, 8, 4).toLowerCase();
  if (!["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand))
    return null;

  const topBoxes = readBoxes(bytes, 0, bytes.length);
  const meta = topBoxes.find((box) => box.type === "meta");
  if (!meta) return null;
  // `meta` is a FullBox: 4 bytes of version+flags precede its children.
  const metaChildren = readBoxes(bytes, meta.payloadStart + 4, meta.end);
  const iinf = metaChildren.find((box) => box.type === "iinf");
  const iloc = metaChildren.find((box) => box.type === "iloc");
  if (!iinf || !iloc) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const exifItemId = findExifItemId(bytes, view, iinf);
  if (exifItemId === null) return null;
  const dataStart = findExifDataStart(bytes, view, iloc, exifItemId);
  if (dataStart === null || dataStart + 4 > bytes.length) return null;
  const tiffHeaderOffset = view.getUint32(dataStart, false);
  return dataStart + 4 + tiffHeaderOffset;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Extracts embedded EXIF/GPS metadata from an image's leading bytes. Never
 * decodes pixels, and caps the region it inspects — `bytes` should already be
 * a bounded leading-bytes read (the background task fetches a Range GET), and
 * this additionally clamps to `MAX_METADATA_READ_BYTES` as a second bound.
 * Returns `null` when the container is unrecognized, carries no EXIF, or is
 * too malformed to parse safely — never throws.
 */
export function extractImageMetadata(
  bytes: Uint8Array,
  contentType: string,
): ImageEmbeddedMetadata | null {
  const bounded =
    bytes.length > MAX_METADATA_READ_BYTES
      ? bytes.subarray(0, MAX_METADATA_READ_BYTES)
      : bytes;
  const type = contentType.toLowerCase().split(";", 1)[0]!.trim();
  try {
    const tiffStart =
      type === "image/jpeg"
        ? findTiffStartInJpeg(bounded)
        : type === "image/png"
          ? findTiffStartInPng(bounded)
          : type === "image/webp"
            ? findTiffStartInWebp(bounded)
            : type === "image/heic" || type === "image/heif"
              ? findTiffStartInHeic(bounded)
              : null;
    if (tiffStart === null) return null;
    return parseTiff(bounded, tiffStart);
  } catch {
    // A truncated Range GET or an unexpected container shape must never fail
    // the background task — treat it the same as "no metadata found".
    return null;
  }
}
