/**
 * One-shot sourcing + upload of vendor brand logos to R2.
 *
 * Why R2 and not `public/`: the bucket already sits behind a Cloudflare zone with
 * Image Transformations enabled (see `src/lib/image-url.ts`), so a single stored
 * original is served at any display size as AVIF/WebP — which is what makes a
 * scraped 48x48 favicon usable at a 16px render. It also keeps ~50 trademarked
 * brand assets out of a public git repo, and off the service worker's precache
 * budget (`scripts/build-sw.mjs`).
 *
 * Everything is normalized to PNG on the way in, so the committed manifest
 * (`src/lib/vendor-logos.generated.ts`) is a flat set of slugs rather than a
 * slug → extension map. Without that manifest the render path can't know which
 * vendors have a logo and would fire a 404 per logo-less vendor on every load.
 *
 * Usage: pnpm --filter web seed-vendor-logos [--dry-run]
 */

import "dotenv/config";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { VENDOR_LOGO_PREFIX, vendorSlug } from "../src/lib/vendor-logo";
import { VENDOR_DOMAINS } from "./vendor-domains";

const execFileAsync = promisify(execFile);

// Resolved against this file, not cwd — the script is equally runnable from the
// repo root and from apps/web, and a cwd-relative path silently writes the
// manifest to whichever one you happened to be in.
const MANIFEST_PATH = fileURLToPath(
  new URL("../src/lib/vendor-logos.generated.ts", import.meta.url),
);

const DRY_RUN = process.argv.includes("--dry-run");

// Both favicon services answer 200 with a fixed generic-globe body for a domain
// they have no icon for, so a 200 is not proof of a real icon — the body hash is.
// Probing a domain that cannot exist yields those hashes at runtime, which is
// sturdier than pinning them (either service may reskin its placeholder). Without
// this a typo'd or dead domain ships a globe, which reads as a real logo and is
// strictly worse than the monogram it would otherwise get.
const PLACEHOLDER_PROBE_DOMAIN = "thisdomaindoesnotexist12345.com";

const SOURCES: { name: string; url: (domain: string) => string }[] = [
  { name: "apple-touch-icon", url: (d) => `https://${d}/apple-touch-icon.png` },
  {
    name: "google",
    url: (d) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`,
  },
  // Content-type is a suggestion here: this endpoint has been observed serving a
  // BMP-payload .ico for one domain and a WebP for another. `toPng` sorts it out.
  {
    name: "duckduckgo",
    url: (d) => `https://icons.duckduckgo.com/ip3/${d}.ico`,
  },
];

interface Candidate {
  buf: Buffer;
  /** Longest edge in px, read from the PNG header. */
  size: number;
  source: string;
}

const md5 = (buf: Buffer) => createHash("md5").update(buf).digest("hex");

async function fetchBinary(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.byteLength > 0 ? buf : null;
  } catch {
    return null;
  }
}

/** Longest edge of a PNG, read straight from the IHDR chunk; null if not a PNG. */
function pngSize(buf: Buffer): number | null {
  const isPng =
    buf.length > 24 &&
    buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (!isPng) return null;
  return Math.max(buf.readUInt32BE(16), buf.readUInt32BE(20));
}

/**
 * Normalize any raster the favicon endpoints hand back into a PNG.
 *
 * Needed because "favicon" is not a format: the observed responses include real
 * PNGs, a BMP-payload .ico, and a WebP served from a .ico URL. Shelling out to
 * ImageMagick handles all of them (and picks the largest frame of a multi-frame
 * .ico) without this script owning an image decoder. `magick` is already assumed
 * by `gen:pwa-icons`, but a missing one degrades to skipping the candidate rather
 * than failing the run.
 */
async function toPng(buf: Buffer): Promise<Buffer | null> {
  if (pngSize(buf)) return buf;
  return new Promise((resolve) => {
    const proc = spawn("magick", ["-", "png:-"]);
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      const out = Buffer.concat(chunks);
      resolve(code === 0 && pngSize(out) ? out : null);
    });
    proc.stdin.on("error", () => resolve(null));
    proc.stdin.end(buf);
  });
}

async function candidatesFor(domain: string): Promise<Candidate[]> {
  const fetched = await Promise.all(
    SOURCES.map(async ({ name, url }) => {
      const raw = await fetchBinary(url(domain));
      if (!raw) return null;
      const png = await toPng(raw);
      const size = png && pngSize(png);
      return png && size ? { buf: png, size, source: name } : null;
    }),
  );
  return fetched.filter((c): c is Candidate => c !== null);
}

async function upload(key: string, buf: Buffer, dir: string) {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket)
    throw new Error("R2_BUCKET_NAME is required to upload vendor logos.");
  const file = path.join(dir, path.basename(key));
  await writeFile(file, buf);
  await execFileAsync("pnpm", [
    "exec",
    "wrangler",
    "r2",
    "object",
    "put",
    `${bucket}/${key}`,
    `--file=${file}`,
    "--content-type=image/png",
    "--cache-control=public, max-age=604800",
    "--remote",
  ]);
}

/**
 * Cross-check the hand-written map against the vendor roster it exists to serve.
 *
 * A map key is only useful if it matches a stored `Vendor.name` exactly — "Home
 * depot" costs that vendor its logo silently, and no type can catch it because
 * the valid set lives in the database. This is the check that does: it names keys
 * matching no vendor (typos, renamed vendors) and vendors carrying real spend
 * with no entry yet (worth adding).
 *
 * Reads `Vendor` rather than the old free-text `Expense.vendor` column, which no
 * longer exists. The count is expense LINES reached through the vendor's charges,
 * not charges — it's a "how much would this logo be seen" ranking, and the ledger
 * is what gets looked at.
 */
async function reconcileWithLedger() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("DATABASE_URL unset — skipping the ledger cross-check.\n");
    return;
  }
  const pool = new Pool({ connectionString: url });
  try {
    const { rows } = await pool.query<{ vendor: string; n: string }>(
      `SELECT v."name" AS vendor, count(e.id) AS n
         FROM "Vendor" v
         LEFT JOIN "Purchase" p ON p."vendorId" = v.id AND p."deletedAt" IS NULL
         LEFT JOIN "Expense" e ON e."purchaseId" = p.id AND e."deletedAt" IS NULL
        WHERE v."deletedAt" IS NULL
        GROUP BY v."name" ORDER BY count(e.id) DESC`,
    );
    const ledger = new Map(rows.map((r) => [r.vendor, Number(r.n)]));

    const unmatched = Object.keys(VENDOR_DOMAINS).filter((v) => !ledger.has(v));
    if (unmatched.length) {
      console.log(`⚠ map keys matching no ledger row: ${unmatched.join(", ")}`);
    }
    const unmapped = [...ledger].filter(([v]) => !(v in VENDOR_DOMAINS));
    if (unmapped.length) {
      console.log(
        `unmapped vendors (monogram only): ${unmapped
          .map(([v, n]) => `${v} (${n})`)
          .join(", ")}`,
      );
    }
    const covered = [...ledger]
      .filter(([v]) => v in VENDOR_DOMAINS)
      .reduce((sum, [, n]) => sum + n, 0);
    const total = [...ledger.values()].reduce((sum, n) => sum + n, 0);
    console.log(
      `\nledger coverage: ${covered}/${total} rows (${Math.round((covered / total) * 100)}%)\n`,
    );
  } finally {
    await pool.end();
  }
}

await reconcileWithLedger();

const placeholderHashes = new Set(
  (
    await Promise.all(
      SOURCES.map(({ url }) => fetchBinary(url(PLACEHOLDER_PROBE_DOMAIN))),
    )
  )
    .filter((b): b is Buffer => b !== null)
    .map(md5),
);

const tmp = await mkdtemp(path.join(tmpdir(), "vendor-logos-"));
const slugs: string[] = [];
const report: string[] = [];
const missing: string[] = [];

try {
  for (const [vendor, domain] of Object.entries(VENDOR_DOMAINS)) {
    // Hash the raw response, not the PNG-normalized one — conversion would give
    // the placeholder a fresh hash and slip it past the filter.
    const candidates = (await candidatesFor(domain)).filter(
      (c) => !placeholderHashes.has(md5(c.buf)),
    );
    const best = candidates.sort((a, b) => b.size - a.size)[0];
    if (!best) {
      missing.push(vendor);
      continue;
    }

    const slug = vendorSlug(vendor);
    if (!DRY_RUN) {
      await upload(`${VENDOR_LOGO_PREFIX}/${slug}.png`, best.buf, tmp);
    }
    slugs.push(slug);
    report.push(
      `${vendor.padEnd(26)} ${best.source.padEnd(17)} ${best.size}px`,
    );
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

const contents = `// GENERATED by scripts/seed-vendor-logos.ts — do not edit by hand.
//
// Every vendor slug with a logo in R2 under \`vendors/<slug>.png\`. Its purpose is
// negative as much as positive: a vendor absent here renders its monogram tile
// immediately, rather than costing a failed request first.

export const VENDOR_LOGO_SLUGS: ReadonlySet<string> = new Set([
${[...slugs]
  .sort()
  .map((s) => `  "${s}",`)
  .join("\n")}
]);
`;

if (!DRY_RUN) await writeFile(MANIFEST_PATH, contents);

console.log("vendor                     source            size");
console.log("-".repeat(56));
for (const line of report) console.log(line);
console.log(
  `\n${report.length} logo(s) ${DRY_RUN ? "found (dry run, nothing uploaded)" : "uploaded"}.`,
);
if (missing.length) {
  console.log(`no icon resolved (monogram fallback): ${missing.join(", ")}`);
}
