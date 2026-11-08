/** Opt-in synthetic local browser measurements, separate from CI timing gates. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { chromium, request, type Page } from "@playwright/test";
import { z } from "zod";

import {
  installStartupProfiling,
  SHELL_HYDRATED_MARK,
  startStartupProfile,
} from "../../tests/e2e/support/navigation-timing";
import { percentile } from "./read-performance-metrics";

const routeSchema = z.object({
  path: z
    .string()
    .startsWith("/")
    .refine((path) => !path.startsWith("//")),
  scope: z.string().min(1),
  useful: z.string().min(1),
  control: z.string().min(1),
});
const scenarioSchema = z.object({
  synthetic: z.literal(true),
  revision: z.string().regex(/^[a-f0-9]{7,40}$/),
  runtime: z.enum(["development", "built-worker"]),
  workload: z.enum(["core", "performance"]),
  source: routeSchema,
  target: routeSchema,
  // Must select a same-origin anchor to target, never a mutation control.
  link: z.string().min(1),
  returnLink: z.string().min(1),
  secondary: routeSchema.optional(),
});
type Route = z.infer<typeof routeSchema>;
type Mode = "cold-document" | "warm-spa" | "fresh-spa" | "cold-contention";

const nullableMs = z.number().nonnegative().nullable();
const sampleSchema = z.object({
  viewport: z.string(),
  pair: z.number().int().nonnegative(),
  mode: z.enum(["cold-document", "warm-spa", "fresh-spa", "cold-contention"]),
  usefulInteractiveMs: z.number().nonnegative(),
  operationResponsesByReady: z.number().int().nonnegative(),
  failedHttpResponsesByReady: z.number().int().nonnegative(),
  contextPageErrorsByReady: z.number().int().nonnegative(),
  cacheEvidence: z.enum([
    "no-operation-response-observed",
    "operation-response-observed",
    "fresh-context",
  ]),
  navigation: z
    .object({
      ttfbMs: nullableMs,
      htmlMs: nullableMs,
      domContentLoadedMs: nullableMs,
    })
    .nullable(),
  documentStartup: z
    .object({
      hydratedAtMs: nullableMs,
      scriptRequests: z.number().int(),
      encodedScriptBytes: z.number(),
      transferredScriptBytes: z.number(),
    })
    .nullable(),
  cpu: z.object({
    taskCpuMs: nullableMs,
    scriptCpuMs: nullableMs,
    layoutCpuMs: nullableMs,
    styleCpuMs: nullableMs,
  }),
});

let measurementPhase = "arguments";

async function ready(page: Page, route: Route) {
  measurementPhase = "primary-content readiness";
  await page.waitForURL(
    (url) => url.pathname + url.search + url.hash === route.path,
  );
  await page
    .locator('[data-app-shell="authenticated"][data-hydrated="true"]')
    .waitFor();
  const scope = page.locator(route.scope);
  await scope.locator(route.useful).filter({ visible: true }).first().waitFor();
  // Trial action checks hit testing, stability and enabled state without writing.
  await scope
    .locator(route.control)
    .filter({ visible: true })
    .first()
    .click({ trial: true });
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }),
  );
}

async function follow(page: Page, route: Route, selector: string, origin: URL) {
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const link = page.locator(selector);
  const href = await link.getAttribute("href");
  if ((await link.evaluate((element) => element.tagName)) !== "A" || !href)
    throw new Error("Scenario link must select an anchor");
  if (new URL(href, origin).href !== new URL(route.path, origin).href)
    throw new Error("Scenario anchor must navigate to the target route");
  await link.click();
  await ready(page, route);
  if ((await page.evaluate(() => performance.timeOrigin)) !== timeOrigin)
    throw new Error("SPA scenario performed a document navigation");
}

async function navigationPerformance() {
  const { values } = parseArgs({
    options: {
      origin: { type: "string" },
      scenario: { type: "string" },
      output: { type: "string" },
      samples: { type: "string", default: "3" },
      device: { type: "string", default: "desktop" },
      contention: { type: "boolean", default: false },
      "budget-ms": { type: "string" },
    },
  });
  if (!values.origin || !values.scenario || !values.output)
    throw new Error("Provide --origin, --scenario and --output");
  const origin = new URL(values.origin);
  if (
    origin.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error("Only an HTTP loopback origin is supported");
  const count = z.coerce.number().int().min(2).max(30).parse(values.samples);
  const device = z.enum(["desktop", "mobile", "both"]).parse(values.device);
  const budget =
    values["budget-ms"] === undefined
      ? null
      : z.coerce.number().positive().finite().parse(values["budget-ms"]);
  measurementPhase = "scenario validation";
  const scenario = scenarioSchema.parse(
    JSON.parse(await readFile(values.scenario, "utf8")),
  );
  if (scenario.source.path === scenario.target.path)
    throw new Error("Source and target must differ");
  for (const route of [scenario.source, scenario.target, scenario.secondary]) {
    if (route && new URL(route.path, origin).origin !== origin.origin)
      throw new Error("Scenario routes must stay on the loopback origin");
  }
  if (values.contention && !scenario.secondary)
    throw new Error("Contention requires a secondary route");
  const artifacts = resolve(import.meta.dirname, "../../../../artifacts");
  const output = resolve(values.output);
  if (!output.startsWith(artifacts + sep))
    throw new Error("Output must be inside the checkout artifacts directory");

  measurementPhase = "local authentication";
  const authentication = await request.newContext({ baseURL: origin.origin });
  let storageState: Awaited<ReturnType<typeof authentication.storageState>>;
  try {
    const response = await authentication.get("/__dev/ready");
    if (!response.ok()) throw new Error("Synthetic local runtime is not ready");
    const login = await authentication.get("/__dev/login?next=/", {
      maxRedirects: 0,
    });
    if (login.status() !== 303) throw new Error("Synthetic local login failed");
    storageState = await authentication.storageState();
  } finally {
    await authentication.dispose();
  }
  measurementPhase = "browser launch";
  const browser = await chromium.launch();
  const browserVersion = browser.version();
  const samples: z.infer<typeof sampleSchema>[] = [];
  try {
    const devices = device === "both" ? ["desktop", "mobile"] : [device];
    for (const viewport of devices) {
      for (let pair = 0; pair < count; pair++) {
        const modes: Mode[] = ["cold-document", "warm-spa", "fresh-spa"];
        if (values.contention) modes.push("cold-contention");
        for (const mode of modes) {
          // Isolated contexts have no browser HTTP cache or client query cache.
          const context = await browser.newContext({
            baseURL: origin.origin,
            storageState,
            serviceWorkers: "block",
            viewport:
              viewport === "mobile"
                ? { width: 390, height: 844 }
                : { width: 1440, height: 1000 },
            isMobile: viewport === "mobile",
            hasTouch: viewport === "mobile",
          });
          try {
            await context.addInitScript(
              installStartupProfiling,
              SHELL_HYDRATED_MARK,
            );
            // Request interception disables HTTP caching and invalidates warm measurements.
            const page = await context.newPage();
            page.setDefaultTimeout(30_000);
            // Recovery during priming also contaminates the measured context.
            let pageErrors = 0;
            const observePageError = () => pageErrors++;
            page.on("pageerror", observePageError);
            if (mode === "warm-spa") {
              await page.goto(scenario.target.path, {
                waitUntil: "domcontentloaded",
              });
              await ready(page, scenario.target);
              // A document reload would discard the query cache being measured.
              await follow(page, scenario.source, scenario.returnLink, origin);
            } else if (mode === "fresh-spa") {
              await page.goto(scenario.source.path, {
                waitUntil: "domcontentloaded",
              });
              await ready(page, scenario.source);
            }
            let operations = 0;
            let failedResponses = 0;
            const observe = (response: import("@playwright/test").Response) => {
              if (
                new URL(response.url()).pathname.startsWith("/api/operations/")
              )
                operations++;
              if (response.status() >= 400) failedResponses++;
            };
            page.on("response", observe);
            const profile = await startStartupProfile(page);
            try {
              const secondaryPage =
                mode === "cold-contention" ? await context.newPage() : null;
              secondaryPage?.setDefaultTimeout(30_000);
              const started = performance.now();
              let secondary: Promise<void> | undefined;
              if (secondaryPage && scenario.secondary) {
                const secondaryRoute = scenario.secondary;
                secondary = secondaryPage
                  .goto(secondaryRoute.path, { waitUntil: "domcontentloaded" })
                  .then(() => ready(secondaryPage, secondaryRoute));
              }
              const primary = (async () => {
                if (mode === "warm-spa" || mode === "fresh-spa")
                  await follow(page, scenario.target, scenario.link, origin);
                else {
                  await page.goto(scenario.target.path, {
                    waitUntil: "domcontentloaded",
                  });
                  await ready(page, scenario.target);
                }
                const usefulInteractiveMs = Math.round(
                  performance.now() - started,
                );
                page.off("response", observe);
                page.off("pageerror", observePageError);
                return {
                  usefulInteractiveMs,
                  startup: await profile.collect(null),
                };
              })();
              // Attach rejection handlers to both branches before either settles.
              const [{ usefulInteractiveMs, startup }] = await Promise.all([
                primary,
                secondary,
              ]);
              const navigation = await page.evaluate(() => {
                const entry = performance.getEntriesByType("navigation")[0];
                if (!(entry instanceof PerformanceNavigationTiming))
                  return null;
                return {
                  ttfbMs: entry.responseStart,
                  htmlMs: entry.responseEnd,
                  domContentLoadedMs: entry.domContentLoadedEventEnd,
                };
              });
              samples.push(
                sampleSchema.parse({
                  viewport,
                  pair,
                  mode,
                  usefulInteractiveMs,
                  operationResponsesByReady: operations,
                  failedHttpResponsesByReady: failedResponses,
                  contextPageErrorsByReady: pageErrors,
                  // Absence of responses cannot prove a query-cache hit or an RPC success.
                  cacheEvidence:
                    mode === "warm-spa"
                      ? operations === 0
                        ? "no-operation-response-observed"
                        : "operation-response-observed"
                      : mode === "fresh-spa"
                        ? operations > 0
                          ? "operation-response-observed"
                          : "no-operation-response-observed"
                        : "fresh-context",
                  navigation:
                    mode === "cold-document" || mode === "cold-contention"
                      ? navigation
                      : null,
                  documentStartup:
                    mode === "cold-document" || mode === "cold-contention"
                      ? {
                          hydratedAtMs: startup.hydratedAtMs,
                          scriptRequests: startup.scriptRequests,
                          encodedScriptBytes: startup.encodedScriptBytes,
                          transferredScriptBytes:
                            startup.transferredScriptBytes,
                        }
                      : null,
                  cpu: {
                    taskCpuMs: startup.taskCpuMs,
                    scriptCpuMs: startup.scriptCpuMs,
                    layoutCpuMs: startup.layoutCpuMs,
                    styleCpuMs: startup.styleCpuMs,
                  },
                }),
              );
            } finally {
              await profile.close();
            }
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
  const groups = [
    ...new Set(samples.map((sample) => `${sample.viewport}/${sample.mode}`)),
  ].map((group) => {
    const matching = samples.filter(
      (sample) => `${sample.viewport}/${sample.mode}` === group,
    );
    const timings = matching.map((sample) => sample.usefulInteractiveMs);
    return {
      group,
      samples: timings.length,
      medianMs: percentile(timings, 0.5),
      p75Ms: percentile(timings, 0.75),
      p95Ms: percentile(timings, 0.95),
      maxMs: Math.max(...timings),
      failedHttpResponsesByReady: matching.reduce(
        (total, sample) => total + sample.failedHttpResponsesByReady,
        0,
      ),
      contextPageErrorsByReady: matching.reduce(
        (total, sample) => total + sample.contextPageErrorsByReady,
        0,
      ),
    };
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        revision: scenario.revision,
        environment: "synthetic-local",
        runtime: scenario.runtime,
        workload: scenario.workload,
        browserVersion,
        mobile: "Chromium touch viewport only; no CPU or network throttling",
        budgetMs: budget,
        readiness:
          "scenario primary content visible, control actionable, hydrated shell, two animation frames",
        groups,
        samples,
      },
      null,
      2,
    ),
  );
  return groups.some(
    (group) =>
      group.failedHttpResponsesByReady > 0 ||
      group.contextPageErrorsByReady > 0 ||
      (budget !== null && group.maxMs > budget),
  )
    ? 1
    : 0;
}

try {
  process.exitCode = await navigationPerformance();
} catch (error) {
  // Playwright errors can include private DOM text and URLs; keep them out of logs.
  process.stderr.write(
    `Navigation measurement failed during ${measurementPhase} (${error instanceof Error ? error.name : "unknown error"}). Output was not updated.\n`,
  );
  process.exitCode = 1;
}
