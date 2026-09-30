import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeE2ERunBundle } from "./e2e-run-bundle";
import { createMacRetailerFixture } from "./mac-retailer-fixture";
import { scrubErrorMessage } from "../src/lib/error-diagnostics";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const nonce = randomBytes(8).toString("hex");
const artifacts = path.join(
  repoRoot,
  "artifacts/mac-import-e2e",
  `retailer-preflight-${nonce}`,
);
mkdirSync(artifacts, { recursive: true });
const started = performance.now();
let fixture: Awaited<ReturnType<typeof createMacRetailerFixture>> | undefined;
let failure: Error | undefined;
try {
  fixture = await createMacRetailerFixture(artifacts, nonce);
  const port = new URL(fixture.origin).port;
  const html = await new Promise<string>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        servername: "shop.example.test",
        path: "/order-history",
        ca: readFileSync(path.join(artifacts, "retailer/tls-cert.pem")),
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += String(chunk);
        });
        response.on("end", () => resolve(body));
      },
    );
    req.once("error", reject);
    req.end();
  });
  if (!html.includes('type="password"'))
    throw new Error(
      "Signed-out fixture lacks authentication detection boundary",
    );
  const actual = execFileSync(
    "/usr/libexec/PlistBuddy",
    [
      "-c",
      "Print :CFBundleIdentifier",
      path.join(fixture.appPath, "Contents/Info.plist"),
    ],
    { encoding: "utf8" },
  ).trim();
  if (actual !== fixture.bundleID)
    throw new Error("Fixture bundle identity differs");
  execFileSync("codesign", ["--verify", "--deep", fixture.appPath], {
    stdio: "ignore",
  });
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
} finally {
  await fixture?.close();
  const results = path.join(artifacts, "run-results.json");
  writeFileSync(
    results,
    JSON.stringify(
      {
        status: failure ? "failed" : "passed",
        failure: failure ? scrubErrorMessage(failure.message) : null,
        preparedIsolatedBrowser: !failure,
        httpsCertificateVerified: !failure,
        appLaunched: false,
        nativeCaptureVerified: false,
        durationMs: Math.round(performance.now() - started),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    writeE2ERunBundle({
      repoRoot,
      outputDir: artifacts,
      kind: "native",
      status: failure ? "failed" : "passed",
      command: [
        "pnpm",
        "--dir",
        "apps/web",
        "exec",
        "tsx",
        "tooling/mac-retailer-preflight.ts",
      ],
      scenario:
        "HTTPS retailer and unique signed browser setup only; native ingress not run",
      fixture: "synthetic-black-crew-shirt",
      fixtureVersion: 1,
      build: {
        fingerprint: null,
        matchesSource: false,
        details: { reason: "setup-only-native-ingress-not-run" },
      },
      evidence: [
        results,
        path.join(artifacts, "retailer/fixture.json"),
        path.join(artifacts, "retailer/requests.json"),
      ],
      cases: [
        {
          name: "HTTPS certificate and unique signed fixture browser setup",
          status: failure ? "failed" : "passed",
          durationMs: Math.round(performance.now() - started),
        },
      ],
    }),
  );
}
if (failure) throw failure;
