/**
 * Publishes a merged HTML report directory to the Nx cache Worker, which
 * serves it publicly at /reports/{run}/{attempt}/{kind}/ (apps/nx-cache).
 *
 *   node tooling/ci-report/publish.ts <vitest|playwright> <dir> [exclude...]
 *
 * NX_CACHE_URL is the Worker's public origin, not a secret: Actions withholds
 * step outputs that contain a secret. Writes `url=` to GITHUB_OUTPUT. Without
 * the token (fork PRs) it publishes nothing and exits successfully; the
 * artifact remains.
 */
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const [kind, input, ...excluded] = process.argv.slice(2);
if ((kind !== "vitest" && kind !== "playwright") || !input)
  throw new Error("usage: publish.ts <vitest|playwright> <dir> [exclude...]");
const directory = input;
const { NX_CACHE_URL, NX_CACHE_TOKEN, GITHUB_RUN_ID, GITHUB_OUTPUT } =
  process.env;
if (!NX_CACHE_URL || !NX_CACHE_TOKEN || !GITHUB_RUN_ID) {
  console.log(
    "No report host configured; the report stays an Actions artifact.",
  );
  process.exit(0);
}

const prefix = `${GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT ?? "1"}/${kind}`;
const files = readdirSync(directory, { recursive: true, encoding: "utf8" })
  .map((entry) => entry.split(sep).join("/"))
  .filter(
    (entry) =>
      !excluded.some(
        (path) => entry === path || entry.startsWith(`${path}/`),
      ) && statSync(join(directory, entry)).isFile(),
  );

async function put(file: string): Promise<void> {
  const url = new URL(`/v1/reports/${prefix}/${file}`, NX_CACHE_URL);
  for (let attempt = 1; ; attempt++) {
    // Transport failures and 5xx responses retry; other statuses are final.
    const status = await fetch(url, {
      method: "PUT",
      headers: { authorization: `Bearer ${NX_CACHE_TOKEN}` },
      body: readFileSync(join(directory, file)),
    }).then(
      (response) => response.status,
      (error: unknown) => String(error),
    );
    if (status === 200) return;
    if (attempt === 3 || (typeof status === "number" && status < 500))
      throw new Error(`PUT ${file}: ${status}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
}

// A small fixed pool: reports hold hundreds of small files.
const queue = [...files];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) await put(file);
  }),
);

const url = new URL(`/reports/${prefix}/`, NX_CACHE_URL).href;
console.log(`Published ${files.length} files to ${url}`);
if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `url=${url}\n`);
