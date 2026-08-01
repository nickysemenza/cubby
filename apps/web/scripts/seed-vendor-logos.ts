/**
 * Sourcing + upload of vendor brand logos to R2, driven by `Vendor.website`.
 *
 * Re-runnable: the vendor roster and its domains both live in the database, so
 * this is "fetch a logo for every vendor that has a website" — filling in a
 * vendor's `website` and re-running is how a new logo gets adopted. (It used to
 * read a hand-curated name → domain map, `scripts/vendor-domains.ts`, which
 * keyed off exact free-text vendor names; the `Vendor` table removed the need
 * for it and the completed vendor normalization migration seeded the column.)
 *
 * Why R2 and not `public/`: the bucket already sits behind a Cloudflare zone with
 * Image Transformations enabled (see `src/lib/image-url.ts`), so a single stored
 * original is served at any display size as AVIF/WebP — which is what makes a
 * scraped 48x48 favicon usable at a 16px render. It also keeps ~50 trademarked
 * brand assets out of a public git repo, and off the service worker's precache
 * budget (`scripts/build-sw.mjs`).
 *
 * Everything is normalized to PNG on the way in. The committed manifest
 * (`src/lib/vendor-logos.generated.ts`) maps each stable public vendor shortcode
 * to its stored name-derived slug. A rename therefore keeps using the original
 * R2 object instead of orphaning it, while a manifest miss renders a monogram
 * without first paying for a failed image request.
 *
 * Usage: pnpm --filter web seed-vendor-logos [--dry-run]
 */

import "dotenv/config";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  MAX_EXTERNAL_IMAGE_BYTES,
  readResponseWithLimit,
} from "@cubby/shared/external-fetch";
import { Pool } from "pg";
import { VENDOR_LOGO_PREFIX, vendorSlug } from "../src/lib/vendor-logo";
import { VENDOR_LOGO_BY_SHORTCODE } from "../src/lib/vendor-logos.generated";

const execFileAsync = promisify(execFile);

// Resolved against this file, not cwd — the script is equally runnable from the
// repo root and from apps/web, and a cwd-relative path silently writes the
// manifest to whichever one you happened to be in.
const MANIFEST_PATH = fileURLToPath(
  new URL("../src/lib/vendor-logos.generated.ts", import.meta.url),
);

const DRY_RUN = process.argv.includes("--dry-run");

const FETCH_TIMEOUT_MS = 10_000;
const CONVERSION_TIMEOUT_MS = 10_000;

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
  /** PNG-normalized bytes, the ones actually uploaded. */
  buf: Buffer;
  /** Longest edge in px, read from `buf`'s PNG header. */
  size: number;
  source: string;
}

async function fetchBinary(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(
      await readResponseWithLimit(res, MAX_EXTERNAL_IMAGE_BYTES),
    );
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
    let outputBytes = 0;
    let settled = false;
    const finish = (result: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(null);
    }, CONVERSION_TIMEOUT_MS);
    proc.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_EXTERNAL_IMAGE_BYTES) {
        proc.kill("SIGKILL");
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    proc.on("error", () => finish(null));
    proc.on("close", (code) => {
      const out = Buffer.concat(chunks);
      finish(code === 0 && pngSize(out) ? out : null);
    });
    proc.stdin.on("error", () => {
      proc.kill("SIGKILL");
      finish(null);
    });
    proc.stdin.end(buf);
  });
}

/**
 * All usable candidates for a domain: fetched and normalized to PNG, before the
 * caller picks the largest.
 *
 * **No contrast/near-white filtering, deliberately.** An earlier revision gated
 * candidates on mean-composited-onto-white to drop all-white marks (which render
 * as a blank tile against the warm-paper background once `grayscale(1)` applies
 * at rest). That was dropped: on the live roster it demoted 10 real brands to
 * monograms — including the single largest vendor by spend — and a faint real
 * logo still carries more identity than an initial. The blank-tile problem is a
 * RENDER concern and belongs in the render path (give the mark a neutral chip
 * behind it), not in what we're willing to store. See `docs/todos.md`.
 */
async function candidatesFor(domain: string): Promise<Candidate[]> {
  const fetched = await Promise.all(
    SOURCES.map(async ({ name, url }) => {
      const raw = await fetchBinary(url(domain));
      if (!raw) return null;
      const png = await toPng(raw);
      const size = png && pngSize(png);
      if (!png || !size) return null;

      return { buf: png, size, source: name };
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

interface VendorRow {
  shortcode: string;
  name: string;
  website: string | null;
  /**
   * Expense LINES reached through this vendor's charges, not charges — it's a
   * "how much would this logo be seen" ranking, and the ledger is what gets
   * looked at.
   */
  spendRows: number;
}

/**
 * The vendor roster, with the ledger weight that decides whether a missing
 * website is worth going and filling in.
 */
async function loadVendors(): Promise<VendorRow[]> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required — vendor domains come from Vendor.website.",
    );
  }
  const pool = new Pool({ connectionString: url });
  try {
    const { rows } = await pool.query<{
      shortcode: string;
      name: string;
      website: string | null;
      spend_rows: string;
    }>(
      `SELECT v.shortcode, v."name", v."website", count(e.id) AS spend_rows
         FROM "Vendor" v
         LEFT JOIN "Purchase" p ON p."vendorId" = v.id AND p."deletedAt" IS NULL
         LEFT JOIN "Expense" e ON e."purchaseId" = p.id AND e."deletedAt" IS NULL
        WHERE v."deletedAt" IS NULL
        GROUP BY v.id, v.shortcode, v."name", v."website"
        ORDER BY count(e.id) DESC, v."name"`,
    );
    return rows.map((r) => ({
      shortcode: r.shortcode,
      name: r.name,
      website: r.website,
      spendRows: Number(r.spend_rows),
    }));
  } finally {
    await pool.end();
  }
}

/**
 * Bare fetchable hostname from a free-text `Vendor.website`, or null.
 *
 * The column is a text field a human types into, so the input is anything from
 * `homedepot.com` to `http://www.homedepot.com/tools?x=1/`. Parsing is delegated
 * to `new URL()` (with an `https://` fallback for a scheme-less value) rather
 * than a regex, because a regex that looks right still mis-handles ports, auth,
 * IDNs and paths-that-look-like-hosts. Returns null instead of throwing: one
 * unparseable row must not abort a whole seeding run.
 *
 * A hostname with no dot is rejected too — a bare word someone typed is not a
 * brand domain, and probing it would return a favicon service's generic globe.
 */
function websiteHost(website: string): string | null {
  const raw = website.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;
  let host: string;
  try {
    host = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
  const bare = host.replace(/^www\./, "");
  return bare.includes(".") ? bare : null;
}

const vendors = await loadVendors();

const tmp = await mkdtemp(path.join(tmpdir(), "vendor-logos-"));
/** Public vendor shortcode -> stable stored slug. */
const manifest: Record<string, string> = {};
/** Slug -> owner, seeded from retained entries before attempting refreshes. */
const slugOwners = new Map<string, VendorRow>();
const report: string[] = [];
/** Has a website, but no real icon came back — the domain may be wrong or dead. */
const noIcon: VendorRow[] = [];
/** Has a website that isn't parseable as a URL at all. */
const badWebsite: VendorRow[] = [];
/** No website set yet, so no logo is even attempted. */
const noWebsite: VendorRow[] = [];

for (const vendor of vendors) {
  const existingSlug = VENDOR_LOGO_BY_SHORTCODE[vendor.shortcode];
  if (!existingSlug) continue;
  manifest[vendor.shortcode] = existingSlug;
  slugOwners.set(existingSlug, vendor);
}

try {
  for (const vendor of vendors) {
    if (!vendor.website) {
      noWebsite.push(vendor);
      continue;
    }
    const domain = websiteHost(vendor.website);
    if (!domain) {
      console.log(
        `⚠ ${vendor.name}: unparseable website ${JSON.stringify(vendor.website)} — skipped`,
      );
      badWebsite.push(vendor);
      continue;
    }

    const candidates = await candidatesFor(domain);
    const best = candidates.sort((a, b) => b.size - a.size)[0];
    if (!best) {
      noIcon.push(vendor);
      continue;
    }

    const slug =
      VENDOR_LOGO_BY_SHORTCODE[vendor.shortcode] ?? vendorSlug(vendor.name);

    // A new name-derived slug must never overwrite another vendor's object.
    const owner = slugOwners.get(slug);
    if (owner && owner.shortcode !== vendor.shortcode) {
      console.log(
        `⚠ slug collision: "${vendor.name}" and "${owner.name}" both slug to "${slug}" — skipped ${vendor.name} rather than overwriting ${VENDOR_LOGO_PREFIX}/${slug}.png.`,
      );
      continue;
    }
    slugOwners.set(slug, vendor);

    if (!DRY_RUN) {
      await upload(`${VENDOR_LOGO_PREFIX}/${slug}.png`, best.buf, tmp);
    }
    manifest[vendor.shortcode] = slug;
    report.push(
      `${vendor.name.padEnd(26)} ${domain.padEnd(30)} ${best.source.padEnd(17)} ${best.size}px`,
    );
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

const contents = `// GENERATED by scripts/seed-vendor-logos.ts — do not edit by hand.
//
// Every live vendor with a logo in R2 under vendors/<slug>.png. The public
// shortcode is stable across renames; the stored slug remains the asset key chosen
// when the logo was first seeded. Absence means VendorMark renders a monogram.

export const VENDOR_LOGO_BY_SHORTCODE: Readonly<Record<string, string>> = {
${Object.entries(manifest)
  .sort(([, a], [, b]) => a.localeCompare(b))
  .map(([id, slug]) => `  "${id}": "${slug}",`)
  .join("\n")}
};
`;

if (!DRY_RUN) await writeFile(MANIFEST_PATH, contents);

console.log(
  "vendor                     domain                         source            size",
);
console.log("-".repeat(86));
for (const line of report) console.log(line);
console.log(
  `\n${report.length} logo(s) ${DRY_RUN ? "found (dry run, nothing uploaded)" : "uploaded"}.`,
);

/**
 * Cross-check the roster against what actually got a logo.
 *
 * Two different problems, so two separate lists. A vendor with a `website` that
 * yielded nothing is a *suspect value* — a typo, a dead domain, or a brand whose
 * site serves no usable icon; worth looking at because it silently reads as "this
 * vendor just has no logo". A vendor with no `website` at all and real ledger
 * spend is the actionable one: nothing is wrong, someone just needs to go fill
 * the field in, and this list is the prompt to do it.
 *
 * Deliberately not automated. A wrong domain yields a confidently-wrong logo,
 * which is far worse than no logo, so the field stays hand-entered and reviewed
 * rather than guessed from the vendor's name.
 */
const describe = (v: VendorRow) => `${v.name} (${v.spendRows})`;
const bySpend = (a: VendorRow, b: VendorRow) => b.spendRows - a.spendRows;

if (badWebsite.length) {
  console.log(
    `\n⚠ unparseable website (fix the field): ${badWebsite
      .map((v) => `${v.name} → ${JSON.stringify(v.website)}`)
      .join(", ")}`,
  );
}
if (noIcon.length) {
  console.log(
    `\n⚠ website set but no icon resolved (check the domain): ${noIcon
      .sort(bySpend)
      .map((v) => `${v.name} → ${v.website}`)
      .join(", ")}`,
  );
}

const actionable = noWebsite.filter((v) => v.spendRows > 0).sort(bySpend);
const noSpend = noWebsite.length - actionable.length;
if (actionable.length) {
  console.log(
    `\nno website set, carrying spend (monogram only — worth filling in): ${actionable
      .map(describe)
      .join(", ")}`,
  );
}
if (noSpend > 0) {
  console.log(
    `(plus ${noSpend} vendor(s) with no website and no ledger rows.)`,
  );
}

const totalRows = vendors.reduce((sum, v) => sum + v.spendRows, 0);
const coveredRows = vendors
  .filter((v) => manifest[v.shortcode])
  .reduce((sum, v) => sum + v.spendRows, 0);
console.log(
  `\nledger coverage: ${coveredRows}/${totalRows} rows (${
    totalRows === 0 ? 0 : Math.round((coveredRows / totalRows) * 100)
  }%) across ${Object.keys(manifest).length}/${vendors.length} vendors`,
);
