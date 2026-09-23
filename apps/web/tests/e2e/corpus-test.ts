import { test as base, expect } from "@playwright/test";

import {
  createE2EWorkerRuntime,
  type E2EWorkerRuntime,
} from "./e2e-worker-runtime";

/** Opt-in corpus tests use a fresh database and workerd harness for each test. */
const test = base.extend<{ e2eRuntime: E2EWorkerRuntime }>({
  e2eRuntime: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright fixture declaration requires destructuring.
    async ({}, provide, testInfo) => {
      const runtime = await createE2EWorkerRuntime({
        authenticated: true,
        parallelIndex: testInfo.parallelIndex,
        corpus: true,
      });
      try {
        await provide(runtime);
      } finally {
        if (testInfo.status !== testInfo.expectedStatus) runtime.debug();
        await runtime.close();
      }
    },
    { auto: true, timeout: 120_000 },
  ],
  baseURL: async ({ e2eRuntime }, provide) => {
    await provide(e2eRuntime.baseURL);
  },
  storageState: async ({ e2eRuntime }, provide) => {
    await provide(e2eRuntime.storageState);
  },
  context: async ({ context }, provide) => {
    await context.route("**/*.sentry.io/**", (route) =>
      route.fulfill({ status: 200, body: "" }),
    );
    await provide(context);
  },
});

export { expect, test };
