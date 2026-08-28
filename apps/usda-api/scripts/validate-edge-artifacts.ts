import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { manifestKey } from "../src/data/artifact-layout.js";
import { cliArgs } from "./lib/cli-args.js";
import { z } from "zod";

const pointerRowSchema = z.object({
  fdc_id: z.number().int(),
  bundle_key: z.string(),
  byte_offset: z.number().int().nonnegative(),
  byte_length: z.number().int().nonnegative(),
});

const manifestSchema = z.object({
  artifactCounts: z.object({ foods: z.number().int().nonnegative() }),
});

const pointerTargetSchema = z.object({ fdc_id: z.number().int() });

interface CliOptions {
  artifactDir: string;
  limit?: number;
}

function parseArgs(): CliOptions {
  const { getArg } = cliArgs();
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
  const usdaDir = path.join(r2Root, "usda");
  const versions = (await fs.readdir(usdaDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (versions.length !== 1) {
    throw new Error(
      `Expected exactly one version under ${usdaDir}, found: ${versions.join(", ") || "none"}`,
    );
  }
  const version = versions.at(0);
  if (!version) throw new Error(`Missing version under ${usdaDir}`);
  const manifest = manifestSchema.parse(
    JSON.parse(
      await fs.readFile(path.join(r2Root, manifestKey(version)), "utf8"),
    ),
  );
  const pointers = createInterface({
    input: createReadStream(pointersPath),
    crlfDelay: Infinity,
  });

  let checked = 0;
  for await (const line of pointers) {
    if (!line.trim()) continue;
    const pointer = pointerRowSchema.parse(JSON.parse(line));
    const filePath = path.join(r2Root, pointer.bundle_key);
    const raw = await readRange(
      filePath,
      pointer.byte_offset,
      pointer.byte_length,
    );
    const parsed = pointerTargetSchema.parse(JSON.parse(raw));
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
