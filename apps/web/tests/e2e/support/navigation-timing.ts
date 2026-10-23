import type { Page } from "@playwright/test";

/** Annotation that navigation helpers attach to the running test with the
 * milliseconds spent loading and hydrating a page; the HTML report shows it
 * beside each test. */
export const NAVIGATION_ANNOTATION = "e2e-navigation-ms";

/** Where a page load's time goes, in ms from navigation start: the server's
 * first byte, the full HTML response, DOMContentLoaded, and the moment the
 * helpers saw the shell hydrated. */
export const NAVIGATION_PHASES_ANNOTATION = "e2e-navigation-phases";

/** Temporary startup attribution for the CI speed investigation. Durations
 * overlap: CPU categories and resource requests must not be added together. */
export const STARTUP_PROFILE_ANNOTATION = "e2e-startup-profile";
export const SHELL_HYDRATED_MARK = "e2e-shell-hydrated";

/** Runs before document scripts. Keep it self-contained for addInitScript. */
export function installStartupProfiling(hydrationMark: string) {
  performance.setResourceTimingBufferSize(3000);
  const observer = new MutationObserver(() => {
    if (
      !document.querySelector(
        '[data-app-shell="authenticated"][data-hydrated="true"]',
      )
    )
      return;
    performance.mark(hydrationMark);
    observer.disconnect();
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-hydrated"],
  });
}

/** Thread CPU counters distinguish execution from elapsed network/wait time.
 * The caller owns close(), including when the actual navigation fails. */
export async function startStartupProfile(page: Page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Performance.enable", { timeDomain: "threadTicks" });
    const { metrics: before } = await session.send("Performance.getMetrics");
    return {
      close: () => session.detach(),
      collect: async (readyObservedAtMs: number | null) => {
        const { metrics } = await session.send("Performance.getMetrics");
        const cpuMs = (name: string) => {
          const start = before.find((metric) => metric.name === name)?.value;
          const end = metrics.find((metric) => metric.name === name)?.value;
          // Missing/reset counters are not evidence of zero CPU.
          return start !== undefined && end !== undefined && end >= start
            ? Math.round((end - start) * 1000)
            : null;
        };
        const resources = await page.evaluate((hydrationMark) => {
          const scripts = performance
            .getEntriesByType("resource")
            .filter(
              (entry): entry is PerformanceResourceTiming =>
                entry instanceof PerformanceResourceTiming,
            )
            .filter(
              (entry) =>
                entry.name.startsWith(`${location.origin}/assets/`) &&
                new URL(entry.name).pathname.endsWith(".js"),
            );
          return {
            hydratedAtMs:
              performance.getEntriesByName(hydrationMark)[0]?.startTime ?? null,
            scriptRequests: scripts.length,
            encodedScriptBytes: scripts.reduce(
              (sum, entry) => sum + entry.encodedBodySize,
              0,
            ),
            transferredScriptBytes: scripts.reduce(
              (sum, entry) => sum + entry.transferSize,
              0,
            ),
            lastScriptResponseMs: Math.max(
              0,
              ...scripts.map((entry) => entry.responseEnd),
            ),
            latestScripts: scripts
              .sort((a, b) => b.responseEnd - a.responseEnd)
              .slice(0, 5)
              .map((entry) => ({
                asset: new URL(entry.name).pathname.split("/").at(-1),
                responseEndMs: Math.round(entry.responseEnd),
                durationMs: Math.round(entry.duration),
              })),
          };
        }, SHELL_HYDRATED_MARK);
        return {
          ...resources,
          readyObservedAtMs,
          taskCpuMs: cpuMs("TaskDuration"),
          scriptCpuMs: cpuMs("ScriptDuration"),
          layoutCpuMs: cpuMs("LayoutDuration"),
          styleCpuMs: cpuMs("RecalcStyleDuration"),
        };
      },
    };
  } catch (error: unknown) {
    await session.detach();
    throw error;
  }
}
