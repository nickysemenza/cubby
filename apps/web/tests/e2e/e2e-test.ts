import { test as base, expect, type BrowserContext } from "@playwright/test";

type WorkerFixtures = {
  cachedContext: BrowserContext;
};

const test = base.extend<{}, WorkerFixtures>({
  baseURL: async ({ browserName: _browserName }, use) => {
    const baseURL = process.env.E2E_BASE_URL;
    if (!baseURL) {
      throw new Error("E2E_BASE_URL was not provided by global setup");
    }
    // oxlint-disable-next-line react/rules-of-hooks -- Playwright names its fixture continuation `use`; this is not a React Hook.
    await use(baseURL);
  },
  cachedContext: [
    async ({ browser }, use, workerInfo) => {
      const baseURL = process.env.E2E_BASE_URL;
      if (!baseURL) {
        throw new Error("E2E_BASE_URL was not provided by global setup");
      }
      const project = workerInfo.project.use;
      const context = await browser.newContext({
        baseURL,
        deviceScaleFactor: project.deviceScaleFactor,
        hasTouch: project.hasTouch,
        isMobile: project.isMobile,
        locale: project.locale,
        storageState: project.storageState,
        userAgent: project.userAgent,
        viewport: project.viewport,
      });
      await use(context);
      await context.close();
    },
    { scope: "worker" },
  ],
  context: async ({ cachedContext }, use) => {
    // oxlint-disable-next-line react/rules-of-hooks -- Playwright fixture continuation, not a React Hook.
    await use(cachedContext);
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    // oxlint-disable-next-line react/rules-of-hooks -- Playwright fixture continuation, not a React Hook.
    await use(page);
    await page
      .evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      })
      .catch(() => undefined);
    await page.close();
  },
});

export { expect, test };
