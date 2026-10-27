/**
 * Publishes a merged HTML report directory to the Nx cache Worker, which
 * serves it publicly at /reports/{run}/{attempt}/{kind}/ (apps/nx-cache).
 *
 *   node tooling/ci-report/publish.ts <vitest|playwright|tester-army> <dir> [exclude...]
 *
 * NX_CACHE_URL is the Worker's public origin, not a secret: Actions withholds
 * step outputs that contain a secret. Writes `url=` to GITHUB_OUTPUT. Without
 * the token (fork PRs) it publishes nothing; the artifact remains.
 */
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";

const [kind, directory, ...excluded] = process.argv.slice(2);
if (!["vitest", "playwright", "tester-army"].includes(kind ?? "") || !directory)
  throw new Error(
    "usage: publish.ts <vitest|playwright|tester-army> <dir> [exclude...]",
  );
const { NX_CACHE_URL, NX_CACHE_TOKEN, GITHUB_RUN_ID, GITHUB_OUTPUT } =
  process.env;
if (!NX_CACHE_URL || !NX_CACHE_TOKEN || !GITHUB_RUN_ID) {
  console.log("No cache token; the report stays an Actions artifact.");
  process.exit(0);
}

// Browsers need these typed; they sniff images and ignore types on fetches.
const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".css", "text/css"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".webm", "video/webm"],
  [".mp4", "video/mp4"],
  [".json", "application/json"],
  [".jsonl", "application/x-ndjson"],
  [".xml", "application/xml"],
  [".md", "text/plain; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
]);

const prefix = `/reports/${GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT ?? "1"}/${kind}/`;
const files = readdirSync(directory, { recursive: true, encoding: "utf8" })
  .map((entry) => entry.split(sep).join("/"))
  .filter(
    (entry) =>
      !excluded.some(
        (path) => entry === path || entry.startsWith(`${path}/`),
      ) && statSync(join(directory, entry)).isFile(),
  );

// Unbounded parallel PUTs of a media-heavy report make Cloudflare close the
// HTTP/2 connection (NGHTTP2_ENHANCE_YOUR_CALM); bound them and retry
// transient network failures. Any file that still fails fails the publish.
async function put(file: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(new URL(prefix + file, NX_CACHE_URL), {
        method: "PUT",
        headers: {
          authorization: `Bearer ${NX_CACHE_TOKEN}`,
          "content-type":
            types.get(extname(file).toLowerCase()) ??
            "application/octet-stream",
        },
        body: readFileSync(join(directory, file)),
      });
      if (response.ok) return;
      if (response.status < 500 || attempt === 3)
        throw new Error(`PUT ${file}: HTTP ${response.status}`);
    } catch (error) {
      if (
        attempt === 3 ||
        (error instanceof Error && error.message.startsWith("PUT "))
      )
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
}
const queue = [...files];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift())
      await put(file);
  }),
);

const url = new URL(prefix, NX_CACHE_URL).href;
const published = await fetch(url);
if (!published.ok)
  throw new Error(`Published report is not readable: HTTP ${published.status}`);
await published.body?.cancel();
console.log(`Published ${files.length} files to ${url}`);
if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `url=${url}\n`);
