import { MAX_IMAGE_UPLOAD_BYTES } from "@cubby/schemas/image";
import { cookbookBundleMetadataSchema } from "@cubby/schemas/import-recipe";

const READ_CHUNK = 64 * 1024;
const MAX_DIRECTORY = 8 * 1024 * 1024;
const MAX_JSON = 16 * 1024 * 1024;
const safePath = (path: string) =>
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  !path.split("/").some((part) => part === "." || part === ".." || part === "");
type ZipEntry = {
  path: string;
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
};
const decoder = new TextDecoder("utf-8", { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = (crcTable[(value ^ byte) & 255] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

function readDirectory(
  directory: Uint8Array<ArrayBuffer>,
  count: number,
  directoryOffset: number,
) {
  const view = new DataView(directory.buffer);
  const entries = new Map<string, ZipEntry>();
  let position = 0;
  for (let index = 0; index < count; index++) {
    if (
      position + 46 > directory.length ||
      view.getUint32(position, true) !== 0x02014b50
    )
      throw new Error("Corrupt ZIP directory");
    const nameLength = view.getUint16(position + 28, true);
    const next =
      position +
      46 +
      nameLength +
      view.getUint16(position + 30, true) +
      view.getUint16(position + 32, true);
    if (next > directory.length) throw new Error("Corrupt ZIP path bounds");
    const path = decoder.decode(
      directory.subarray(position + 46, position + 46 + nameLength),
    );
    if (!safePath(path.endsWith("/") ? path.slice(0, -1) : path))
      throw new Error(`Unsafe ZIP path: ${path}`);
    if (entries.has(path)) throw new Error(`Duplicate ZIP path: ${path}`);
    const entry = {
      path,
      flags: view.getUint16(position + 8, true),
      method: view.getUint16(position + 10, true),
      crc: view.getUint32(position + 16, true),
      compressed: view.getUint32(position + 20, true),
      size: view.getUint32(position + 24, true),
      offset: view.getUint32(position + 42, true),
    };
    if (
      entry.flags & 1 ||
      ![0, 8].includes(entry.method) ||
      entry.size === 0xffffffff ||
      entry.compressed === 0xffffffff ||
      entry.offset + 30 > directoryOffset ||
      view.getUint16(position + 34, true) !== 0
    )
      throw new Error(`Unsupported ZIP entry: ${path}`);
    entries.set(path, entry);
    position = next;
  }
  if (position !== directory.length)
    throw new Error("Corrupt ZIP directory length");
  return entries;
}

/** Random-access ZIP reads keep the File backed by disk, never a whole-file buffer. */
export async function openCookbookBundle(file: Blob, signal?: AbortSignal) {
  const read = async (start: number, length: number) => {
    signal?.throwIfAborted();
    if (start < 0 || length < 0 || start + length > file.size)
      throw new Error("ZIP entry exceeds archive size");
    const result = new Uint8Array(
      await file.slice(start, start + length).arrayBuffer(),
    );
    signal?.throwIfAborted();
    return result;
  };
  const tailStart = Math.max(0, file.size - 65557);
  const tail = await read(tailStart, file.size - tailStart);
  const footer = new DataView(tail.buffer);
  let end = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (
      footer.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + footer.getUint16(offset + 20, true) === tail.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("Not a complete ZIP archive");
  const count = footer.getUint16(end + 10, true);
  const directorySize = footer.getUint32(end + 12, true);
  const directoryOffset = footer.getUint32(end + 16, true);
  if (
    footer.getUint16(end + 4, true) !== 0 ||
    footer.getUint16(end + 6, true) !== 0 ||
    footer.getUint16(end + 8, true) !== count ||
    count === 65535 ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  )
    throw new Error("Multipart and ZIP64 bundles are unsupported");
  if (
    count > 20_000 ||
    directorySize > MAX_DIRECTORY ||
    directoryOffset + directorySize !== tailStart + end
  )
    throw new Error("ZIP directory exceeds supported size or bounds");
  const directory = new Uint8Array(directorySize);
  for (let position = 0; position < directorySize; position += READ_CHUNK)
    directory.set(
      await read(
        directoryOffset + position,
        Math.min(READ_CHUNK, directorySize - position),
      ),
      position,
    );
  const entries = readDirectory(directory, count, directoryOffset);

  const readEntry = async (path: string, maximum: number) => {
    const entry = entries.get(path);
    if (!entry) throw new Error(`Bundle is missing ${path}`);
    if (entry.size > maximum || entry.compressed > maximum + READ_CHUNK)
      throw new Error(`Bundle entry size exceeds ${maximum} bytes: ${path}`);
    const local = await read(entry.offset, 30);
    const header = new DataView(local.buffer);
    if (
      header.getUint32(0, true) !== 0x04034b50 ||
      header.getUint16(8, true) !== entry.method ||
      header.getUint16(6, true) !== entry.flags
    )
      throw new Error(`Corrupt ZIP entry header: ${path}`);
    const nameSize = header.getUint16(26, true);
    if (decoder.decode(await read(entry.offset + 30, nameSize)) !== path)
      throw new Error(`ZIP path differs from entry header: ${path}`);
    const start = entry.offset + 30 + nameSize + header.getUint16(28, true);
    if (start + entry.compressed > directoryOffset)
      throw new Error(`ZIP entry exceeds payload bounds: ${path}`);
    let offset = 0;
    const compressed = new ReadableStream<Uint8Array<ArrayBuffer>>({
      async pull(controller) {
        try {
          signal?.throwIfAborted();
          if (offset === entry.compressed) {
            controller.close();
            return;
          }
          const chunk = await read(
            start + offset,
            Math.min(READ_CHUNK, entry.compressed - offset),
          );
          offset += chunk.length;
          controller.enqueue(chunk);
        } catch (error) {
          controller.error(error);
        }
      },
    });
    const stream =
      entry.method === 8
        ? compressed.pipeThrough(new DecompressionStream("deflate-raw"))
        : compressed;
    const reader = stream.getReader();
    const bytes = new Uint8Array(entry.size);
    let length = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const result = await reader.read();
        if (result.done) break;
        length += result.value.length;
        if (length > entry.size)
          throw new Error(
            `Expanded ZIP entry size exceeds its declaration: ${path}`,
          );
        bytes.set(result.value, length - result.value.length);
      }
      if (length !== entry.size || crc32(bytes) !== entry.crc)
        throw new Error(`ZIP entry size or checksum differs: ${path}`);
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return bytes;
  };
  const manifest = JSON.parse(
    decoder.decode(await readEntry("manifest.json", MAX_JSON)),
  );
  // Validate the extraction path before using it for an archive lookup.
  const { cookbookBundleManifestSchema } =
    await import("@cubby/schemas/import-recipe");
  const parsedManifest = cookbookBundleManifestSchema.parse(manifest);
  const extraction = JSON.parse(
    decoder.decode(await readEntry(parsedManifest.extraction, MAX_JSON)),
  );
  const metadata = cookbookBundleMetadataSchema.parse({
    ...extraction,
    manifest: parsedManifest,
  });
  for (const image of metadata.manifest.images) {
    const entry = entries.get(image.path);
    if (!entry || entry.size !== image.bytes)
      throw new Error(`Bundle image size differs from manifest: ${image.path}`);
  }
  return {
    metadata,
    async readImage(sourcePath: string) {
      const image = metadata.manifest.images.find(
        (candidate) => candidate.source_path === sourcePath,
      );
      if (!image) throw new Error(`Bundle image is missing: ${sourcePath}`);
      const bytes = await readEntry(image.path, MAX_IMAGE_UPLOAD_BYTES);
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      if (digest !== image.sha256)
        throw new Error(
          `Bundle image hash differs from manifest: ${image.path}`,
        );
      return bytes;
    },
  };
}

/** Backpressure covers read/decompress/PUT/attach together, not just HTTP calls. */
export async function runTwoAtATime<T>(
  items: readonly T[],
  job: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        const item = items[index];
        if (item !== undefined) await job(item);
      }
    }),
  );
}
