import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const coverageSchema = z.object({
  result: z.array(z.object({ url: z.string() })),
});
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const webRoot = path.join(repoRoot, "apps/web");

test("loading the native AI runner does not initialize the application server", () => {
  const coverageRoot = mkdtempSync(path.join(tmpdir(), "cubby-ai-startup-"));
  try {
    const config = pathToFileURL(path.join(webRoot, "e2e.config.ts")).href;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(config)})`,
      ],
      {
        cwd: webRoot,
        env: {
          ...process.env,
          NODE_V8_COVERAGE: coverageRoot,
          DATABASE_URL:
            "postgres://synthetic:synthetic@127.0.0.1:55432/synthetic",
          TESTER_ARMY_TARGET: "ios",
          TESTER_ARMY_ORIGIN: "http://127.0.0.1:3000",
          TESTER_ARMY_DEVICE_ID: "Synthetic iPhone",
          TESTER_ARMY_SESSION: "synthetic-startup",
          TESTER_ARMY_CF_API_TOKEN: "synthetic-token",
          TESTER_ARMY_CF_ACCOUNT_ID: "00000000000000000000000000000000",
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    const loaded = new Set(
      readdirSync(coverageRoot)
        .filter((name) => name.endsWith(".json"))
        .flatMap((name) =>
          coverageSchema
            .parse(
              JSON.parse(readFileSync(path.join(coverageRoot, name), "utf8")),
            )
            .result.map((entry) => entry.url),
        ),
    );
    const serverRoot = pathToFileURL(path.join(webRoot, "src/server/")).href;
    // The account default comes from the lightweight Worker environment module.
    const environmentModule = `${serverRoot}cf-env.ts`;
    const serverModules = [...loaded].filter(
      (url) => url.startsWith(serverRoot) && !url.startsWith(environmentModule),
    );
    assert.equal(
      serverModules.length,
      0,
      `runner loaded ${serverModules.length} application server modules`,
    );
    assert.equal(
      result.status,
      0,
      "runner configuration import must exit successfully",
    );
    assert.ok(
      loaded.has(config),
      "coverage must observe the actual runner configuration",
    );
  } finally {
    rmSync(coverageRoot, { recursive: true, force: true });
  }
});
