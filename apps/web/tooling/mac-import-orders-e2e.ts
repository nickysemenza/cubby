import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { captureE2ERunIdentity, writeE2ERunBundle } from "./e2e-run-bundle";
import { macImportOrders } from "./mac-import-orders";
import { scrubErrorMessage } from "../src/lib/error-diagnostics";

if (
  process.platform !== "darwin" ||
  process.argv.slice(2).some((arg) => arg !== "--")
)
  throw new Error(
    "Usage on an unlocked Mac: pnpm --dir apps/web exec tsx tooling/mac-import-orders-e2e.ts",
  );
const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(webRoot, "../..");
const outputDir = path.join(
  repoRoot,
  "artifacts/mac-import-e2e",
  `orders_${randomBytes(8).toString("hex")}`,
);
mkdirSync(outputDir, { recursive: true });
const started = captureE2ERunIdentity(repoRoot);
const childManifest = z.object({
  status: z.string(),
  source: z.object({ commit: z.string() }),
  replayableFromCommit: z.boolean(),
  command: z.array(z.string()),
  cases: z.array(z.object({ status: z.string() })),
  build: z.object({
    matchesSource: z.boolean(),
    details: z.object({
      sourceFingerprint: z.string(),
      sourceFingerprintVersion: z.number(),
      binaryFingerprintFormat: z.string(),
      webFingerprint: z.string(),
    }),
  }),
  evidence: z.array(z.object({ path: z.string(), sha256: z.string() })),
});
const cases = macImportOrders.map((order) => ({
  name: order.join(","),
  status: "not-run",
  durationMs: 0,
}));
let activeChild: ReturnType<typeof spawn> | undefined;
let interrupted = false;
let reuseManifest = process.env.CUBBY_E2E_REUSE_NATIVE_MANIFEST;
let nativeFingerprint: string | undefined;
const evidence: string[] = [];
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    interrupted = true;
    if (!activeChild?.pid) return;
    try {
      process.kill(-activeChild.pid, "SIGTERM");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        return;
      console.error(
        scrubErrorMessage(
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  });

function retainChild(manifestPath: string, order: string): boolean {
  const raw = readFileSync(manifestPath);
  const manifest = childManifest.parse(JSON.parse(raw.toString("utf8")));
  const sourceDir = path.dirname(manifestPath);
  const destination = path.join(outputDir, order);
  mkdirSync(destination, { recursive: true });
  for (const file of manifest.evidence) {
    const original = path.resolve(sourceDir, file.path);
    const relative = path.relative(sourceDir, original);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Child evidence escapes its sealed bundle");
    const bytes = readFileSync(original);
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
      throw new Error(`Child evidence checksum differs: ${file.path}`);
    const target = path.join(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(original, target);
    evidence.push(target);
  }
  const target = path.join(destination, "child-manifest.json");
  writeFileSync(target, raw);
  evidence.push(target);
  if (manifest.status !== "passed") return false;
  const results = z.object({
    status: z.literal("passed"),
    milestones: z.object({
      databaseVerified: z.literal(true),
      browserCaptureVerified: z.literal(true),
      nativeBookingReviewed: z.literal(true),
      nativePhotoApproved: z.literal(true),
      retailerCommitted: z.literal(true),
      composedGraphVerified: z.literal(true),
    }),
  });
  results.parse(
    JSON.parse(
      readFileSync(path.join(destination, "run-results.json"), "utf8"),
    ),
  );
  const composed = z.object({
    order: z.array(z.string()),
    canonicalEdges: z.object({ expense: z.string() }),
  });
  const graph = composed.parse(
    JSON.parse(
      readFileSync(
        path.join(destination, "native-composed-results.json"),
        "utf8",
      ),
    ),
  );
  const details = manifest.build.details;
  const matches =
    manifest.source.commit === started.source.commit &&
    manifest.replayableFromCommit &&
    manifest.build.matchesSource &&
    details.sourceFingerprintVersion === 2 &&
    details.binaryFingerprintFormat === "app-bundle-v1" &&
    details.webFingerprint === started.build.fingerprint &&
    (!nativeFingerprint || nativeFingerprint === details.sourceFingerprint) &&
    manifest.command.slice(-2).join(" ") === `--order ${order}` &&
    manifest.cases.every((item) => item.status === "passed") &&
    graph.order.join(",") === order;
  if (matches) nativeFingerprint = details.sourceFingerprint;
  return matches;
}

async function runOrder(
  order: string,
): Promise<{ code: number | null; manifest?: string }> {
  return await new Promise((resolve, reject) => {
    const environment = { ...process.env };
    if (reuseManifest)
      environment.CUBBY_E2E_REUSE_NATIVE_MANIFEST = reuseManifest;
    const child = spawn(
      "pnpm",
      [
        "--dir",
        webRoot,
        "exec",
        "tsx",
        "tooling/mac-import-e2e.ts",
        "--order",
        order,
      ],
      {
        cwd: repoRoot,
        detached: true,
        env: environment,
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    activeChild = child;
    let pending = "";
    let manifest: string | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = line.match(/^\[mac-import-e2e\] Artifact: (.+)$/u);
        if (match?.[1]) manifest = match[1].trim();
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      activeChild = undefined;
      resolve({ code, manifest });
    });
  });
}

let failure: string | undefined;
try {
  for (const item of cases) {
    if (interrupted) {
      failure =
        "Interrupted before next order; remaining orders were not launched";
      break;
    }
    const began = performance.now();
    const result = await runOrder(item.name);
    item.durationMs = Math.round(performance.now() - began);
    const verified = result.manifest
      ? retainChild(result.manifest, item.name)
      : false;
    item.status =
      result.code === 0 && verified && !interrupted ? "passed" : "failed";
    if (item.status !== "passed") {
      failure = interrupted
        ? "Interrupted; owned child cleanup requested"
        : `Order ${item.name} failed; remaining orders were not launched`;
      break;
    }
    reuseManifest = result.manifest;
  }
} catch (error) {
  failure = scrubErrorMessage(
    error instanceof Error ? error.message : String(error),
  );
  const item = cases.find((value) => value.status === "not-run");
  if (item) item.status = "failed";
} finally {
  const status =
    !failure && cases.every((item) => item.status === "passed")
      ? "passed"
      : "failed";
  const results = path.join(outputDir, "run-results.json");
  writeFileSync(
    results,
    JSON.stringify({ status, cases, failure: failure ?? null }, null, 2) + "\n",
  );
  const manifest = writeE2ERunBundle({
    repoRoot,
    outputDir,
    started: {
      ...started,
      build: {
        ...started.build,
        matchesSource: started.build.matchesSource && status === "passed",
        details: {
          ...started.build.details,
          reason:
            status === "passed"
              ? "verified-six-native-child-bundles"
              : "native-child-provenance-incomplete",
        },
      },
    },
    kind: "native",
    status,
    command: [
      "pnpm",
      "--dir",
      "apps/web",
      "exec",
      "tsx",
      "tooling/mac-import-orders-e2e.ts",
    ],
    scenario: "Six isolated native CSV/photo/receipt arrival orders",
    fixture: "synthetic-monarch-wardrobe",
    fixtureVersion: 2,
    cases,
    evidence: [results, ...evidence],
  });
  console.log(`[mac-import-orders-e2e] Artifact: ${manifest}`);
  if (status !== "passed") process.exitCode = 1;
}
