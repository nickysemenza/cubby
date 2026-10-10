import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { mobile } from "@e2e-dev/mobile";
import { z } from "zod";
import {
  modelConfiguration,
  testerArmyAgent,
} from "./tooling/tester-army/model";
import { testerArmyReporter } from "./tooling/tester-army/report";
import { readBrowserCookies } from "./tooling/tester-army/scenario";

process.env.E2E_TELEMETRY_DISABLED = "1";
const target = z.enum(["web", "ios"]).parse(process.env.TESTER_ARMY_TARGET);
const origin = z.url().parse(process.env.TESTER_ARMY_ORIGIN);
const cookies = target === "web" ? readBrowserCookies() : [];
const inferenceToken = modelConfiguration().TESTER_ARMY_CF_API_TOKEN;
const inferenceSecret: Record<string, string> = {};
if (inferenceToken) inferenceSecret.inferenceToken = inferenceToken;

export default {
  projectId: "cubby-tester-army-trial",
  tests: `tests/tester-army/${target}-journeys.e2e.ts`,
  targets: [
    target === "web"
      ? {
          name: "web",
          engine: web({
            browser: "chromium",
            viewport: { width: 1440, height: 1000 },
          }),
          app: { url: origin, identity: "cubby-synthetic-web" },
        }
      : {
          name: "ios",
          engine: mobile({
            platform: "ios",
            device: z.string().min(1).parse(process.env.TESTER_ARMY_DEVICE_ID),
            session: z.string().min(1).parse(process.env.TESTER_ARMY_SESSION),
          }),
          app: {
            bundleId: "com.nickysemenza.cubby",
            identity: "cubby-synthetic-ios",
            launchArguments: ["--cubby-e2e-server", origin],
          },
        },
  ],
  workers: 1,
  retries: 0,
  // A journey that waits on a live agent run sets its own longer deadline.
  timeout: 240_000,
  launchTimeout: 240_000,
  assertionTimeout: 15_000,
  cleanupTimeout: 60_000,
  cache: process.env.TESTER_ARMY_REPLAY === "1" ? "read-write" : "off",
  reporters: ["list", "junit", testerArmyReporter],
  secrets: {
    ...Object.fromEntries(
      cookies.map((cookie, index) => [`session-${index}`, cookie.value]),
    ),
    ...inferenceSecret,
  },
  agents: {
    default: {
      ...testerArmyAgent(),
      maxSteps: 40,
      maxModelCalls: 40,
      context:
        "Cubby household inventory. Use only the synthetic records named in each goal. On web, the global search palette can find products by name. On iOS, Find searches the catalog; Save closes the editor. Names and amounts in quotes are exact.",
    },
  },
} satisfies E2EConfig;
