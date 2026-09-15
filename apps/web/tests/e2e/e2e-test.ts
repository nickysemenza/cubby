import { test as base, expect } from "@playwright/test";

import {
  createE2EWorkerRuntime,
  type E2EWorkerRuntime,
} from "./e2e-worker-runtime";

type TestFixtures = { e2eFailureDiagnostics: void };
type WorkerFixtures = { e2eRuntime: E2EWorkerRuntime };

const test = base.extend<TestFixtures, WorkerFixtures>({
  e2eRuntime: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright requires object destructuring to declare fixture dependencies.
    async ({}, provide, workerInfo) => {
      const runtime = await createE2EWorkerRuntime({
        authenticated: workerInfo.project.metadata.authenticated === true,
        parallelIndex: workerInfo.parallelIndex,
      });
      try {
        await provide(runtime);
      } finally {
        await runtime.close();
      }
    },
    { auto: true, scope: "worker", timeout: 120_000 },
  ],
  baseURL: async ({ e2eRuntime }, provide) => {
    await provide(e2eRuntime.baseURL);
  },
  storageState: async ({ e2eRuntime }, provide) => {
    await provide(e2eRuntime.storageState);
  },
  e2eFailureDiagnostics: [
    async ({ e2eRuntime }, provide, testInfo) => {
      await provide();
      if (testInfo.status !== testInfo.expectedStatus) e2eRuntime.debug();
    },
    { auto: true },
  ],
});

export { expect, test };
