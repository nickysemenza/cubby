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
 * Everything is normalized to PNG on the way in, so the committed manifest
 * (`src/lib/vendor-logos.generated.ts`) maps id → slug rather than needing a
 * slug → extension lookup too. Keyed by vendor id, not by a freshly recomputed
 * name-slug: renaming a vendor after it's been seeded must not orphan its
 * uploaded logo (see `src/lib/vendor-logo-lookup.ts`'s `vendorLogoSlug`). The
 * R2 object key itself is still the name-derived slug — only the manifest that
 * points at it changed. Without the manifest at all, the render path can't
 * know which vendors have a logo and would fire a 404 per logo-less vendor on
 * every load.
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
  /**
   * Raw bytes exactly as fetched, before PNG normalization. This is what the
   * placeholder-hash guard must describe — `toPng` gives a placeholder a fresh
   * hash on the way to becoming `buf`, so hashing the normalized bytes instead
   * would let a converted placeholder slip past the filter unnoticed.
   */
  raw: Buffer;
  /** PNG-normalized bytes, the ones actually uploaded. */
  buf: Buffer;
  /** Longest edge in px, read from `buf`'s PNG header. */
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

      return { raw, buf: png, size, source: name };
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

// The probe is expected to fail with 404 from both services rather than
// serving their placeholder body for a domain that plainly does not exist —
// `fetchBinary` returns null on any non-2xx, so that 404 yields nothing to
// hash and this set is likely empty on a normal run. That makes the guard
// below INERT in practice, not a defense-in-depth no-op, and without this
// warning that degradation is invisible. Since the near-white gate was
// removed, an empty set means there is NO automated defense left against a
// generic globe shipping as a brand — the `noIcon` report at the end of the
// run, read by a human, is the only backstop.
if (placeholderHashes.size === 0) {
  console.log(
    "⚠ placeholder probe yielded 0 hashes (both favicon services likely 404 the nonexistent-domain probe rather than serving a placeholder body) — the placeholder-hash guard is INERT this run. Nothing automated is now filtering a generic-globe placeholder; skim the per-vendor table below.",
  );
}

const tmp = await mkdtemp(path.join(tmpdir(), "vendor-logos-"));
/** vendor id -> slug, the shape written to the manifest. */
const manifest: Record<string, string> = {};
/** slug -> the first vendor that claimed it, to detect two vendors colliding. */
const slugOwners = new Map<string, VendorRow>();
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

    // Hash the RAW response, not the PNG-normalized one — `toPng` would give a
    // placeholder a fresh hash and slip it past this filter.
    const candidates = (await candidatesFor(domain)).filter(
      (c) => !placeholderHashes.has(md5(c.raw)),
    );
    const best = candidates.sort((a, b) => b.size - a.size)[0];
    if (!best) {
      noIcon.push(vendor);
      continue;
    }

    const slug = vendorSlug(vendor.name);

    // Two different vendors slugging identically would otherwise share one R2
    // object silently — one vendor's logo overwrites the other's on upload,
    // and only the last-written one is ever seen again. This can't be an
    // exception thrown mid-run (a slow-to-notice typo shouldn't abort every
    // vendor after it), so it's a loud, operator-visible warning instead; see
    // the header note in `src/lib/vendor-logo.ts` for the id-re-key escape
    // hatch if this ever actually fires.
    const owner = slugOwners.get(slug);
    if (owner && owner.id !== vendor.id) {
      console.log(
        `⚠ slug collision: "${vendor.name}" and "${owner.name}" both slug to "${slug}" — they will SHARE one R2 object (${VENDOR_LOGO_PREFIX}/${slug}.png), and whichever uploads last wins.`,
      );
    }
    slugOwners.set(slug, vendor);

    if (!DRY_RUN) {
      await upload(`${VENDOR_LOGO_PREFIX}/${slug}.png`, best.buf, tmp);
    }
    manifest[vendor.id] = slug;
    report.push(
      `${vendor.name.padEnd(26)} ${domain.padEnd(30)} ${best.source.padEnd(17)} ${best.size}px`,
    );
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

const contents = `// GENERATED by scripts/seed-vendor-logos.ts — do not edit by hand.
//
// Every vendor with a logo in R2 under \`vendors/<slug>.png\`, keyed by vendor id
// so a rename doesn't orphan the logo (see \`~/lib/vendor-logo-lookup\`'s
// \`vendorLogoSlug\`). Absence is as meaningful as presence: a vendor id absent
// here renders its monogram tile immediately, rather than costing a failed
// request first.

export const VENDOR_LOGO_BY_ID: Readonly<Record<string, string>> = {
${Object.entries(manifest)
  .sort(([, a], [, b]) => a.localeCompare(b))
  .map(([id, slug]) => `  "${id}": "${slug}",`)
  .join("\n")}
};

/**
 * Fallback for the rare miss: a vendor id absent from the table above (newer
 * than the last seed run) still needs to know whether its NAME-derived slug
 * happens to have a logo. Derived from the table above, not re-emitted from
 * the seeder's own loop, so it can never drift from it.
 */
export const VENDOR_LOGO_SLUGS: ReadonlySet<string> = new Set(
  Object.values(VENDOR_LOGO_BY_ID),
);
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
  .filter((v) => manifest[v.id])
  .reduce((sum, v) => sum + v.spendRows, 0);
console.log(
  `\nledger coverage: ${coveredRows}/${totalRows} rows (${
    totalRows === 0 ? 0 : Math.round((coveredRows / totalRows) * 100)
  }%) across ${Object.keys(manifest).length}/${vendors.length} vendors`,
);
