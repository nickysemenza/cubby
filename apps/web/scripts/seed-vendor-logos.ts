/**
 * Sourcing + upload of vendor brand logos to R2, driven by `Vendor.website`.
 *
 * Re-runnable: the vendor roster and its domains both live in the database, so
 * this is "fetch a logo for every vendor that has a website" — filling in a
 * vendor's `website` and re-running is how a new logo gets adopted. (It used to
 * read a hand-curated name → domain map, `scripts/vendor-domains.ts`, which
 * keyed off exact free-text vendor names; the `Vendor` table removed the need
 * for it and `vendor-split-migration.ts websites` seeded the column from it.)
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

interface VendorRow {
  /**
   * Unused: logo assets are keyed by the name-derived slug, not the vendor id —
   * see the header note in `src/lib/vendor-logo.ts` for why, and what it costs.
   */
  id: string;
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
      id: string;
      name: string;
      website: string | null;
      spend_rows: string;
    }>(
      `SELECT v.id, v."name", v."website", count(e.id) AS spend_rows
         FROM "Vendor" v
         LEFT JOIN "Purchase" p ON p."vendorId" = v.id AND p."deletedAt" IS NULL
         LEFT JOIN "Expense" e ON e."purchaseId" = p.id AND e."deletedAt" IS NULL
        WHERE v."deletedAt" IS NULL
        GROUP BY v.id, v."name", v."website"
        ORDER BY count(e.id) DESC, v."name"`,
    );
    return rows.map((r) => ({
      id: r.id,
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
/** Has a website, but no real icon came back — the domain may be wrong or dead. */
const noIcon: VendorRow[] = [];
/** Has a website that isn't parseable as a URL at all. */
const badWebsite: VendorRow[] = [];
/** No website set yet, so no logo is even attempted. */
const noWebsite: VendorRow[] = [];

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

    // Hash the raw response, not the PNG-normalized one — conversion would give
    // the placeholder a fresh hash and slip it past the filter.
    const candidates = (await candidatesFor(domain)).filter(
      (c) => !placeholderHashes.has(md5(c.buf)),
    );
    const best = candidates.sort((a, b) => b.size - a.size)[0];
    if (!best) {
      noIcon.push(vendor);
      continue;
    }

    const slug = vendorSlug(vendor.name);
    if (!DRY_RUN) {
      await upload(`${VENDOR_LOGO_PREFIX}/${slug}.png`, best.buf, tmp);
    }
    slugs.push(slug);
    report.push(
      `${vendor.name.padEnd(26)} ${domain.padEnd(30)} ${best.source.padEnd(17)} ${best.size}px`,
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
const loggedSlugs = new Set(slugs);
const coveredRows = vendors
  .filter((v) => loggedSlugs.has(vendorSlug(v.name)))
  .reduce((sum, v) => sum + v.spendRows, 0);
console.log(
  `\nledger coverage: ${coveredRows}/${totalRows} rows (${
    totalRows === 0 ? 0 : Math.round((coveredRows / totalRows) * 100)
  }%) across ${slugs.length}/${vendors.length} vendors`,
);
