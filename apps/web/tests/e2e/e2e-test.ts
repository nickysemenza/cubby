import { test as base, expect } from "@playwright/test";

import { retryStaleKeepAlive } from "../../tooling/stale-keep-alive";
import {
  WORKERD_EXPLORER_ANNOTATION,
  WORKERD_LOGS_ATTACHMENT,
} from "../../tooling/e2e-workerd-logs";
import type { WorkerdProfile } from "../../tooling/workerd-harness";
import {
  createE2EWorkerRuntime,
  type E2EWorkerRuntime,
} from "./e2e-worker-runtime";

type TestFixtures = {
  e2eFailureDiagnostics: void;
  /** `false` starts the test's browser signed out of the worker's account. */
  signedIn: boolean;
};
type WorkerFixtures = {
  e2eRuntime: E2EWorkerRuntime;
  /** Which queues and peers the Worker runs (`WORKERD_PROFILES`). */
  workerdProfile: WorkerdProfile;
  objectStoragePublicUrl: string | undefined;
};

/** `CUBBY_E2E_VIDEO=1` records every test in the run; specs pace demos on it. */
const recordingVideo = process.env.CUBBY_E2E_VIDEO === "1";

const test = base.extend<TestFixtures, WorkerFixtures>({
  // `video` is worker-scoped: a spec's `test.use({ video })`, even to the
  // default, splits its tests into separate workers, each booting another
  // browser, database, and Worker harness. Recording is chosen per run here.
  video: [recordingVideo ? "on" : "off", { scope: "worker" }],
  workerdProfile: ["offline", { scope: "worker", option: true }],
  objectStoragePublicUrl: [undefined, { scope: "worker", option: true }],
  e2eRuntime: [
    async ({ workerdProfile, objectStoragePublicUrl }, provide, workerInfo) => {
      const runtime = await createE2EWorkerRuntime({
        authenticated: true,
        parallelIndex: workerInfo.parallelIndex,
        profile: workerdProfile,
        objectStorage: { publicUrl: objectStoragePublicUrl },
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
  signedIn: [true, { option: true }],
  storageState: async ({ e2eRuntime, signedIn }, provide) => {
    await provide(
      signedIn ? e2eRuntime.storageState : { cookies: [], origins: [] },
    );
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
    // `page.request` is this context's request client.
    retryStaleKeepAlive(context.request);
    await provide(context);
  },
  request: async ({ request }, provide) => {
    retryStaleKeepAlive(request);
    await provide(request);
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

export { expect, recordingVideo, test };
