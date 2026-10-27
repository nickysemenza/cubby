import { test as base, expect } from "@playwright/test";
import { attachRecorder } from "playwright-recorder-plus";
import { withDerivedRefresh } from "./derived-refresh";
import { disableBrowserSentry } from "./browser-bootstrap";
import { getFixtureDb } from "../fixtures/core";

import { retryStaleKeepAlive } from "#web/tooling/stale-keep-alive.ts";
import {
  WORKERD_EXPLORER_ANNOTATION,
  WORKERD_LOGS_ATTACHMENT,
} from "#web/tooling/e2e-workerd-logs.ts";
import type { WorkerdProfile } from "#web/tooling/workerd-harness.ts";
import {
  installStartupProfiling,
  SHELL_HYDRATED_MARK,
} from "./navigation-timing";
import {
  createE2EWorkerRuntime,
  type E2EWorkerRuntime,
} from "./e2e-worker-runtime";

type TestFixtures = {
  e2eFailureDiagnostics: void;
  e2eDerivedRefresh: void;
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
  // The page fixture owns opt-in MP4 capture; do not also record built-in WebM.
  video: ["off", { scope: "worker" }],
  viewport: async ({ viewport }, provide) => {
    await provide(recordingVideo ? { width: 1920, height: 1080 } : viewport);
  },
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
    await context.addInitScript(disableBrowserSentry);
    if (
      Boolean(process.env.CI) ||
      process.env.CUBBY_E2E_STARTUP_PROFILE === "1"
    ) {
      await context.addInitScript(installStartupProfiling, SHELL_HYDRATED_MARK);
    }
    // `page.request` is this context's request client.
    retryStaleKeepAlive(context.request);
    await provide(context);
  },
  page: async ({ page }, provide, testInfo) => {
    if (!recordingVideo) return provide(page);
    const videoPath = testInfo.outputPath("video.mp4");
    const recorder = await attachRecorder(page, { path: videoPath });
    try {
      await provide(page);
    } finally {
      await recorder.stop();
      await recorder.finalized;
      await testInfo.attach("video", {
        path: videoPath,
        contentType: "video/mp4",
      });
    }
  },
  request: async ({ request }, provide) => {
    retryStaleKeepAlive(request);
    await provide(request);
  },
  // Offline lanes omit provider consumers, but user journeys still exercise
  // eventual SQL projections through the real paged frontier.
  e2eDerivedRefresh: [
    async ({ workerdProfile, e2eRuntime: _e2eRuntime }, provide) => {
      if (workerdProfile !== "offline") return provide();
      await withDerivedRefresh(getFixtureDb(), provide);
    },
    { auto: true },
  ],
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
