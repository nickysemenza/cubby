import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { imageProcessingHello } from "@cubby/schemas/image-processing";
import type { APIRequestContext, Page } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { doorbellUrl } from "~/lib/doorbell";
import { image, imageProcessingJob, job } from "~/server/db/schema";
import { getDb } from "~/server/db/helpers";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { persistAppleImageDescriptionSubmission } from "~/server/domains/image-processing/repo/image-processing-submission";
import { createEvidenceHarnessContext } from "./fixtures/core";
import { expect, test } from "./support/e2e-test";
import { startOperation } from "./support/start-operation";

const jpeg = readFileSync(
  new URL("./fixtures/synthetic-white.jpg", import.meta.url),
);

const helloFor = (deviceId: string) =>
  imageProcessingHello.parse({
    protocolVersion: 1,
    type: "hello",
    deviceId,
    platform: "macos",
    appVersion: "synthetic",
    deviceName: "Synthetic Mac",
    participation: { automaticWork: true },
    capabilities: {
      foreground: true,
      visionSubjectLift: { available: false },
      actualImageDescription: { available: true, revision: 1 },
      jpegNormalization: { available: false, revision: 1 },
    },
  });

const pulled = z.object({
  command: z
    .looseObject({ jobId: z.string(), attemptId: z.string() })
    .nullable(),
  remotePaused: z.boolean(),
});

/** Subscribe from the authenticated page; resolves with the close code once the server ends it. */
const subscribeAndSend = (page: Page) =>
  page.evaluate(
    (url) =>
      new Promise<{ opened: boolean; closeCode: number }>((resolve) => {
        const socket = new WebSocket(url);
        let opened = false;
        socket.addEventListener("open", () => {
          opened = true;
          socket.send("hello");
        });
        socket.addEventListener("close", (event) =>
          resolve({ opened, closeCode: event.code }),
        );
      }),
    doorbellUrl("imageProcessing.work", new URL(page.url()).origin).href,
  );

test.describe("companion doorbell", () => {
  /** Apple description jobs waiting for a device, their backoff elapsed. */
  async function waitingJobs(
    page: Page,
    request: APIRequestContext,
    objectStorageUrl: string,
    count: number,
  ) {
    const { db } = await createEvidenceHarnessContext(page);
    const database = getDb(db);

    const jobIds: string[] = [];
    for (let index = 0; index < count; index++) {
      const key = `synthetic/${randomUUID()}.jpg`;
      expect(
        (
          await request.put(`${objectStorageUrl}/e2e-bucket/${key}`, {
            data: jpeg,
            headers: { "Content-Type": "image/jpeg" },
          })
        ).ok(),
      ).toBe(true);
      const source = await createUploadedImageRecord(db, {
        key,
        filename: "synthetic-white.jpg",
        contentType: "image/jpeg",
        size: jpeg.length,
      });
      await database
        .update(image)
        .set({
          sha256: createHash("sha256").update(jpeg).digest("hex"),
          width: 2,
          height: 3,
        })
        .where(eq(image.id, source.id));
      const { jobId } = await persistAppleImageDescriptionSubmission(db, {
        id: source.shortcode,
      });
      if (!jobId) throw new Error("Apple description job was not scheduled");
      // The state an earlier dispatch leaves when no device answered.
      await database
        .update(imageProcessingJob)
        .set({
          state: "waiting_for_device",
          attemptId: null,
        })
        .where(eq(imageProcessingJob.id, jobId));
      await database
        .update(job)
        .set({
          state: "queued",
          leaseToken: null,
          leaseExpiresAt: null,
          availableAt: sql`now() - interval '1 minute'`,
        })
        .where(eq(job.key, `image-processing:${jobId}`));
      jobIds.push(jobId);
    }
    await page.goto("/");
    return jobIds;
  }

  // A job queued while no capable device was connected waits for one; a
  // companion pulls it as soon as it connects, without waiting for a ring.
  test("a connecting companion pulls work already waiting for a device", async ({
    page,
    request,
    e2eRuntime,
  }) => {
    const [jobId] = await waitingJobs(
      page,
      request,
      e2eRuntime.objectStorageUrl,
      1,
    );
    const hello = helloFor(randomUUID());
    const first = pulled.parse(
      (await startOperation(page.request, "imageProcessing.pull", { hello }))
        .body,
    );
    expect(first.command?.jobId).toBe(jobId);
    if (!first.command) throw new Error("No command was pulled");

    const completed = await startOperation(
      page.request,
      "imageProcessing.complete",
      {
        deviceId: hello.deviceId,
        result: {
          jobId: first.command.jobId,
          attemptId: first.command.attemptId,
          completedAt: new Date().toISOString(),
          outcome: {
            kind: "describe_image",
            status: "failed",
            retryable: false,
            reason: "Synthetic companion failure",
          },
        },
      },
    );
    expect(completed.body).toEqual({ adopted: true });
    const next = pulled.parse(
      (await startOperation(page.request, "imageProcessing.pull", { hello }))
        .body,
    );
    expect(next.command).toBeNull();
  });

  // The doorbell only rings; a subscriber that talks is disconnected.
  test("the doorbell accepts a subscriber and refuses its messages", async ({
    page,
  }) => {
    await page.goto("/");
    expect(await subscribeAndSend(page)).toEqual({
      opened: true,
      closeCode: 1008,
    });
  });
});
