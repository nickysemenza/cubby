import { test as base, expect } from "@playwright/test";

import {
  WORKERD_EXPLORER_ANNOTATION,
  WORKERD_LOGS_ATTACHMENT,
} from "../../tooling/e2e-workerd-logs";
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
  context: async ({ context }, provide) => {
    // Routing even one URL disables Chromium's HTTP cache for this context.
    // That made every full-page navigation refetch hundreds of immutable JS
    // assets. Set the test-only flag before app scripts run instead.
    await context.addInitScript(() => {
      Object.defineProperty(window, "__CUBBY_E2E_DISABLE_SENTRY__", {
        value: true,
      });
    });
    await provide(context);
  },
  e2eFailureDiagnostics: [
    async ({ e2eRuntime }, provide, testInfo) => {
      // The harness is shared by every test in this Playwright worker.
      e2eRuntime.clearLogs();
      await provide();
      if (testInfo.status === testInfo.expectedStatus) return;
      // A structured attachment replaces the harness's stdout-only debug()
      // dump; the run reporter copies it into the sanitized E2E bundle.
      await testInfo.attach(WORKERD_LOGS_ATTACHMENT, {
        body: JSON.stringify(e2eRuntime.getLogs(), null, 2),
        contentType: "application/json",
      });
      testInfo.annotations.push({
        type: WORKERD_EXPLORER_ANNOTATION,
        description: e2eRuntime.explorerUrl,
      });
    },
    { auto: true },
  ],
});

export { expect, test };
