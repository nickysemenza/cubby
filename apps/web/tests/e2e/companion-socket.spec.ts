import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { imageProcessingHello } from "@cubby/schemas/image-processing";
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
  command: z.looseObject({ jobId: z.string() }),
});

// A job queued while no capable device was connected waits for one. Before a
// connecting companion claimed waiting work, such a job sat until an unrelated
// wakeup (a retry, a web catch-up, the daily cron), even with a capable
// device connected the whole time.
test("a companion that connects receives work already waiting for a device", async ({
  page,
  request,
  e2eRuntime,
}) => {
  const { db } = await createEvidenceHarnessContext(page);
  const database = getDb(db);
  await updateImageProcessingSettings(db, { enabled: false, paused: false });
  const key = `synthetic/${randomUUID()}.jpg`;
  expect(
    (
      await request.put(`${e2eRuntime.objectStorageUrl}/e2e-bucket/${key}`, {
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
  // The state an earlier dispatch leaves when no device answered, with its
  // retry backoff already elapsed.
  await database
    .update(imageProcessingJob)
    .set({
      state: "waiting_for_device",
      attemptId: null,
      leaseExpiresAt: null,
      nextAttemptAt: sql`now() - interval '1 minute'`,
    })
    .where(eq(imageProcessingJob.id, jobId));

  const hello = imageProcessingHello.parse({
    protocolVersion: 1,
    type: "hello",
    deviceId: randomUUID(),
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
  await page.goto("/");
  const received = await page.evaluate(
    async ({ path, hello, timeoutMs }) => {
      const url = new URL(path, window.location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      const messages: string[] = [];
      try {
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("error", () => reject(new Error("socket")));
          socket.addEventListener("open", () => resolve(), { once: true });
        });
        socket.addEventListener("message", (event) =>
          messages.push(String(event.data)),
        );
        socket.send(JSON.stringify(hello));
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (messages.some((message) => message.includes('"command"'))) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return messages;
      } finally {
        socket.close();
      }
    },
    { path: IMAGE_PROCESSING_SOCKET_PATH, hello, timeoutMs: 20_000 },
  );
  const commands = received.flatMap(
    (message) => commandMessage.safeParse(JSON.parse(message)).data ?? [],
  );
  expect(commands.map(({ command }) => command.jobId)).toContain(jobId);
});
