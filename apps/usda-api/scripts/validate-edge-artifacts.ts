import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline/promises";

interface PointerRow {
  fdc_id: number;
  bundle_key: string;
  byte_offset: number;
  byte_length: number;
}

interface Manifest {
  artifactCounts: {
    foods: number;
  };
}

interface CliOptions {
  artifactDir: string;
  limit?: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const getArg = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const limit = getArg("--limit");
  return {
    artifactDir:
      getArg("--artifacts") ?? path.resolve("artifacts", "usda-edge"),
    limit: limit ? Number(limit) : undefined,
  };
}

async function readRange(filePath: string, offset: number, length: number) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function main() {
  const options = parseArgs();
  const pointersPath = path.join(options.artifactDir, "pointers.ndjson");
  const r2Root = path.join(options.artifactDir, "r2");
  const manifest = JSON.parse(
    await fs.readFile(path.join(r2Root, "manifest.json"), "utf8"),
  ) as Manifest;
  const pointers = createInterface({
    input: createReadStream(pointersPath),
    crlfDelay: Infinity,
  });

  let checked = 0;
  for await (const line of pointers) {
    if (!line.trim()) continue;
    const pointer = JSON.parse(line) as PointerRow;
    const filePath = path.join(r2Root, pointer.bundle_key);
    const raw = await readRange(
      filePath,
      pointer.byte_offset,
      pointer.byte_length,
    );
    const parsed = JSON.parse(raw);
    if (parsed.fdc_id !== pointer.fdc_id) {
      throw new Error(
        `Pointer mismatch for ${pointer.fdc_id}: read ${parsed.fdc_id}`,
      );
    }
    checked += 1;
    if (options.limit && checked >= options.limit) break;
  }

  if (!options.limit && checked !== manifest.artifactCounts.foods) {
    throw new Error(
      `Pointer count mismatch: checked ${checked}, manifest has ${manifest.artifactCounts.foods}`,
    );
  }

  console.log(`Validated ${checked} USDA edge pointers`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
