// Build one USDA release's R2 shards from an FDC CSV download:
//   pnpm --dir packages/usda release:build --csv <dir> --release YYYY-MM --out <dir> [--limit N]
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { z } from "zod";
import { buildRelease } from "../src/release/builder/build-release";
import { releaseId } from "../src/release/shard";

const { values } = parseArgs({
  options: {
    csv: { type: "string" },
    release: { type: "string" },
    out: { type: "string" },
    limit: { type: "string" },
  },
  strict: true,
});

const args = z
  .object({
    csv: z.string().min(1),
    release: releaseId,
    out: z.string().min(1),
    limit: z.coerce.number().int().positive().optional(),
  })
  .parse(values);

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const result = await buildRelease({
  csvDir: path.resolve(args.csv),
  release: args.release,
  outDir: path.resolve(args.out),
  limit: args.limit,
  log: (message) => console.log(`[${elapsed()}] ${message}`),
});

const sizes = [...result.lineBytes].sort((a, b) => a - b);
const percentile = (p: number) =>
  sizes[Math.min(sizes.length - 1, Math.floor((sizes.length * p) / 100))] ?? 0;
console.log(
  JSON.stringify(
    {
      wallSeconds: (Date.now() - started) / 1000,
      peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
      out: path.join(path.resolve(args.out), args.release),
      ...result.manifest,
      lines: result.lineCount,
      gzipBytes: result.gzipBytes,
      uncompressedBytes: result.uncompressedBytes,
      lineBytes: {
        mean: Math.round(
          result.uncompressedBytes / Math.max(1, result.lineCount),
        ),
        p50: percentile(50),
        p99: percentile(99),
        max: sizes.at(-1) ?? 0,
      },
    },
    null,
    2,
  ),
);
