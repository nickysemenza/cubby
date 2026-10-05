import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  imageProcessingClientMessage,
  imageProcessingHello,
} from "@cubby/schemas/image-processing";
import type { APIRequestContext, Page } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { image, imageProcessingJob } from "~/server/db/schema";
import { IMAGE_PROCESSING_SOCKET_PATH } from "~/server/direct-socket-paths";
import { getDb } from "~/server/repo/database-helpers";
import { createUploadedImageRecord } from "~/server/repo/image";
import { updateImageProcessingSettings } from "~/server/repo/image-processing-maintenance";
import { persistAppleImageDescriptionSubmission } from "~/server/repo/image-processing-submission";
import { createEvidenceHarnessContext } from "./fixtures-core";
import { expect, test } from "./e2e-test";

const jpeg = readFileSync(
  new URL("./fixtures/synthetic-white.jpg", import.meta.url),
);

const commandMessage = z.object({
  type: z.literal("command"),
  command: z.looseObject({ jobId: z.string(), attemptId: z.string() }),
});
type Command = z.infer<typeof commandMessage>["command"];

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

const failedResult = (
  command: Command,
): z.input<typeof imageProcessingClientMessage> => ({
  protocolVersion: 1,
  type: "result",
  result: {
    jobId: command.jobId,
    attemptId: command.attemptId,
    completedAt: new Date().toISOString(),
    outcome: {
      kind: "describe_image",
      status: "failed",
      retryable: false,
      reason: "Synthetic companion failure",
    },
  },
});

declare global {
  interface Window {
    companionSockets?: Record<
      string,
      { socket: WebSocket; messages: string[] }
    >;
  }
}

/** A companion socket opened from the authenticated page, named for later steps. */
async function openSocket(page: Page, name: string) {
  await page.evaluate(
    async ({ name, path }) => {
      const url = new URL(path, window.location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      const messages: string[] = [];
      socket.addEventListener("message", (event) =>
        messages.push(String(event.data)),
      );
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("error", () => reject(new Error("socket")));
        socket.addEventListener("open", () => resolve(), { once: true });
      });
      const sockets = (window.companionSockets ??= {});
      sockets[name] = { socket, messages };
    },
    { name, path: IMAGE_PROCESSING_SOCKET_PATH },
  );
}

const send = (
  page: Page,
  name: string,
  message: z.input<typeof imageProcessingClientMessage>,
) =>
  page.evaluate(
    ({ name, text }) => window.companionSockets?.[name]?.socket.send(text),
    { name, text: JSON.stringify(imageProcessingClientMessage.parse(message)) },
  );

const close = (page: Page, name: string) =>
  page.evaluate((name) => {
    window.companionSockets?.[name]?.socket.close();
  }, name);

async function commandsOn(page: Page, name: string): Promise<Command[]> {
  const messages = await page.evaluate(
    (name) => window.companionSockets?.[name]?.messages ?? [],
    name,
  );
  return messages.flatMap(
    (message) =>
      commandMessage.safeParse(JSON.parse(message)).data?.command ?? [],
  );
}

const acknowledged = async (page: Page, name: string) =>
  (
    await page.evaluate(
      (name) => window.companionSockets?.[name]?.messages ?? [],
      name,
    )
  ).filter((message) => message.includes('"acknowledge"')).length;

test.describe("companion socket", () => {
  /** Apple description jobs waiting for a device, their backoff elapsed. */
  async function waitingJobs(
    page: Page,
    request: APIRequestContext,
    objectStorageUrl: string,
    count: number,
  ) {
    const { db } = await createEvidenceHarnessContext(page);
    const database = getDb(db);
    await updateImageProcessingSettings(db, { enabled: false, paused: false });
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
          leaseExpiresAt: null,
          nextAttemptAt: sql`now() - interval '1 minute'`,
        })
        .where(eq(imageProcessingJob.id, jobId));
      jobIds.push(jobId);
    }
    await page.goto("/");
    return jobIds;
  }

  // A job queued while no capable device was connected waits for one. Before a
  // connecting companion claimed waiting work, such a job sat until an
  // unrelated wakeup (a retry, a web catch-up, the daily cron), even with a
  // capable device connected the whole time.
  test("a companion that connects receives work already waiting for a device", async ({
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
    await openSocket(page, "mac");
    await send(page, "mac", helloFor(randomUUID()));
    await expect
      .poll(async () => (await commandsOn(page, "mac")).map((c) => c.jobId), {
        timeout: 20_000,
      })
      .toContain(jobId);
  });

  // Each finished job claims the next, but a reconnect replays the outbox
  // right after hello: refilling for replayed results too would hand the
  // device one job per replay, past what it runs at once, and the extras
  // would wait out their leases.
  test("only a result for this connection's job claims the next one", async ({
    page,
    request,
    e2eRuntime,
  }) => {
    const jobIds = await waitingJobs(
      page,
      request,
      e2eRuntime.objectStorageUrl,
      3,
    );
    const hello = helloFor(randomUUID());
    await openSocket(page, "before");
    await send(page, "before", hello);
    await expect
      .poll(async () => (await commandsOn(page, "before")).length, {
        timeout: 20_000,
      })
      .toBe(1);
    const [earlier] = await commandsOn(page, "before");
    await close(page, "before");

    await openSocket(page, "after");
    await send(page, "after", hello);
    await expect
      .poll(async () => (await commandsOn(page, "after")).length, {
        timeout: 20_000,
      })
      .toBe(1);
    const [current] = await commandsOn(page, "after");
    if (!earlier || !current) throw new Error("No command was offered");

    await send(page, "after", failedResult(earlier));
    await expect.poll(() => acknowledged(page, "after")).toBe(1);
    // A refill follows its acknowledgement within one claim; give a wrongly
    // offered job time to arrive before asserting none did.
    await page.waitForTimeout(3_000);
    expect(await commandsOn(page, "after")).toHaveLength(1);

    await send(page, "after", failedResult(current));
    await expect
      .poll(async () => (await commandsOn(page, "after")).length, {
        timeout: 20_000,
      })
      .toBe(2);
    const offered = (await commandsOn(page, "before"))
      .concat(await commandsOn(page, "after"))
      .map((command) => command.jobId);
    expect(new Set(offered)).toEqual(new Set(jobIds));
  });
});
