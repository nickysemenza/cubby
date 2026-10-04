import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { mobile } from "@e2e-dev/mobile";
import { z } from "zod";
import {
  modelConfiguration,
  testerArmyModel,
  testerArmyProviderOptions,
} from "./tooling/tester-army/model";
import { testerArmyReporter } from "./tooling/tester-army/report";
import { readBrowserCookies } from "./tooling/tester-army/scenario";

process.env.E2E_TELEMETRY_DISABLED = "1";
const target = z.enum(["web", "ios"]).parse(process.env.TESTER_ARMY_TARGET);
const journey = z
  .enum(["product", "import"])
  .default("product")
  .parse(process.env.TESTER_ARMY_JOURNEY);
if (journey === "import" && target !== "web")
  throw new Error("The live import journey runs on web only");
const JOURNEY_CONTEXT = {
  product:
    "Cubby household inventory. Use the synthetic product only. On web, the global search palette can find products by name. On iOS, Find searches the catalog. Save closes the editor.",
  import:
    "Cubby household inventory. A vendor page lists saved order confirmation emails; each importable order has an Import order button, which starts an agent run and then shows a View import link to that run's page. Use the synthetic vendor only.",
};
const origin = z.url().parse(process.env.TESTER_ARMY_ORIGIN);
const cookies = target === "web" ? readBrowserCookies() : [];

export default {
  projectId: "cubby-tester-army-trial",
  tests: `tests/tester-army/${target}-${journey}.e2e.ts`,
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
  // The import journey waits for a real coordinator run to finish.
  timeout: journey === "import" ? 600_000 : 240_000,
  launchTimeout: 240_000,
  assertionTimeout: 15_000,
  cleanupTimeout: 60_000,
  cache: process.env.TESTER_ARMY_REPLAY === "1" ? "read-write" : "off",
  reporters: ["list", "junit", testerArmyReporter],
  secrets: {
    ...Object.fromEntries(
      cookies.map((cookie, index) => [`session-${index}`, cookie.value]),
    ),
    inferenceToken: modelConfiguration().TESTER_ARMY_CF_API_TOKEN,
  },
  agents: {
    default: {
      model: testerArmyModel(),
      providerOptions: testerArmyProviderOptions,
      maxSteps: 20,
      maxModelCalls: 20,
      context: JOURNEY_CONTEXT[journey],
    },
  },
} satisfies E2EConfig;
