const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_DECODED_PNG_BYTES = 64 * 1024 * 1024;

const readU32 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset]! << 24) |
    (bytes[offset + 1]! << 16) |
    (bytes[offset + 2]! << 8) |
    bytes[offset + 3]!) >>>
  0;

const paeth = (left: number, up: number, upLeft: number): number => {
  const prediction = left + up - upLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upLeftDistance = Math.abs(prediction - upLeft);
  return leftDistance <= upDistance && leftDistance <= upLeftDistance
    ? left
    : upDistance <= upLeftDistance
      ? up
      : upLeft;
};

type ParsedPng = {
  width: number;
  height: number;
  compressed: Uint8Array;
};
type PngDimensions = Pick<ParsedPng, "width" | "height">;

function validatePngHeader(data: Uint8Array): PngDimensions {
  const width = readU32(data, 0);
  const height = readU32(data, 4);
  if (
    !width ||
    !height ||
    data[8] !== 8 ||
    data[9] !== 6 ||
    data[10] !== 0 ||
    data[11] !== 0 ||
    data[12] !== 0
  )
    throw new Error("Transparent derivative must be an 8-bit RGBA PNG");
  return { width, height };
}

function parsePng(bytes: Uint8Array): ParsedPng {
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value))
    throw new Error("Transparent derivative is not a PNG");
  let offset = PNG_SIGNATURE.length;
  let dimensions: PngDimensions | null = null;
  const idat: Uint8Array[] = [];
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = new TextDecoder().decode(
      bytes.subarray(offset + 4, offset + 8),
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new Error("Malformed PNG chunk");
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      if (dimensions || length !== 13) throw new Error("Malformed PNG header");
      dimensions = validatePngHeader(data);
    } else if (type === "IDAT") {
      if (!dimensions) throw new Error("PNG data precedes header");
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!dimensions || idat.length === 0)
    throw new Error("Transparent derivative PNG is unsupported or too large");
  const compressed = new Uint8Array(
    idat.reduce((total, chunk) => total + chunk.length, 0),
  );
  let compressedOffset = 0;
  for (const chunk of idat) {
    compressed.set(chunk, compressedOffset);
    compressedOffset += chunk.length;
  }
  return { ...dimensions, compressed };
}

function reconstructedByte(
  filter: number,
  value: number,
  left: number,
  up: number,
  upLeft: number,
): number {
  if (filter === 0) return value;
  if (filter === 1) return (value + left) & 0xff;
  if (filter === 2) return (value + up) & 0xff;
  if (filter === 3) return (value + Math.floor((left + up) / 2)) & 0xff;
  if (filter === 4) return (value + paeth(left, up, upLeft)) & 0xff;
  throw new Error("Transparent derivative PNG uses an invalid filter");
}

function scanTransparency(
  decoded: Uint8Array,
  width: number,
  height: number,
): boolean {
  const rowBytes = width * 4;
  let cursor = 0;
  let previous = new Uint8Array(rowBytes);
  let hasTransparent = false;
  let hasVisible = false;
  for (let row = 0; row < height; row += 1) {
    const filter = decoded[cursor++]!;
    const current = decoded.subarray(cursor, cursor + rowBytes);
    cursor += rowBytes;
    for (let index = 0; index < rowBytes; index += 1) {
      current[index] = reconstructedByte(
        filter,
        current[index]!,
        index >= 4 ? current[index - 4]! : 0,
        previous[index]!,
        index >= 4 ? previous[index - 4]! : 0,
      );
    }
    for (let alpha = 3; alpha < rowBytes; alpha += 4) {
      hasTransparent ||= current[alpha]! < 255;
      hasVisible ||= current[alpha]! > 0;
    }
    previous = current.slice();
  }
  return hasTransparent && hasVisible;
}

/**
 * Decode only the PNG shape native subject lifting promises to upload: non-
 * interlaced 8-bit RGBA. This bounded parser rejects opaque, empty, indexed,
 * and unsupported results before a derivative can be adopted.
 */
export async function hasMeaningfulPngTransparency(
  bytes: Uint8Array,
): Promise<boolean> {
  const { width, height, compressed } = parsePng(bytes);
  const expectedBytes = (width * 4 + 1) * height;
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes > MAX_DECODED_PNG_BYTES
  )
    throw new Error("Transparent derivative PNG is unsupported or too large");
  const stream = new Blob([Uint8Array.from(compressed).buffer])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  const decoded = new Uint8Array(await new Response(stream).arrayBuffer());
  if (decoded.length !== expectedBytes)
    throw new Error("Transparent derivative PNG data is malformed");
  return scanTransparency(decoded, width, height);
}
