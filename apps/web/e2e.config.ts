import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { prepareE2EProcessEnvironment } from "./tooling/e2e-process-env";
import { journeyAgent } from "./tooling/tester-army/model";

prepareE2EProcessEnvironment();
process.env.E2E_TELEMETRY_DISABLED = "1";

export default {
  projectId: "cubby-web-journeys",
  tests: "tests/tester-army/**/*.e2e.ts",
  targets: [
    {
      name: "web",
      engine: web({
        browser: "chromium",
        viewport: { width: 1440, height: 1000 },
      }),
      app: {
        url: "http://127.0.0.1",
        identity: "cubby-synthetic-web",
        environment: "test",
      },
    },
  ],
  agents: { default: journeyAgent() },
  workers: 1,
  retries: 0,
  trace: "on",
  video: "on",
  timeout: 240_000,
  maxDuration: 1_200_000,
  assertionTimeout: 15_000,
  output: "artifacts/tester-army/run",
  cache: process.env.TESTER_ARMY_FRESH === "1" ? "off" : "read-write",
  reporters: ["list", "junit"],
  secrets: { "gateway-token": process.env.TESTER_ARMY_CF_API_TOKEN ?? "" },
} satisfies E2EConfig;
