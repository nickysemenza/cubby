import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  completeCompanionImageProcessingOutput,
  completeCompanionImageProcessingInput,
  imageProcessingHello,
  imageProcessingNormalizedOutcome,
  pullCompanionImageProcessingOutput,
  pullCompanionImageProcessingInput,
} from "@cubby/schemas/image-processing";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import {
  image,
  imageProcessingAttempt,
  imageProcessingJob,
} from "~/server/db/schema";
import { preferredImageDescriptionPolicy } from "~/server/image-processing/description-policy";
import { getDb } from "~/server/repo/database-helpers";
import { createUploadedImageRecord } from "~/server/repo/image";
import { saveImageDescriptionAnalysis } from "~/server/repo/image-processing";
import { updateImageProcessingSettings } from "~/server/repo/image-processing-maintenance";
import { imageDescriptionInputFingerprint } from "~/server/services/image-description.service";
import { scheduleImageProcessingJobs } from "~/server/services/image-processing.service";
import { ensureRun } from "~/server/runs/ensure-run";
import { createEvidenceHarnessContext } from "./fixtures-core";
import { expect, test } from "./e2e-test";

const original = readFileSync(
  new URL("./fixtures/synthetic-white.avif", import.meta.url),
);
const jpeg = readFileSync(
  new URL("./fixtures/synthetic-white.jpg", import.meta.url),
);
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

type CompanionRequest =
  | z.input<typeof pullCompanionImageProcessingInput>
  | z.input<typeof completeCompanionImageProcessingInput>;
type NormalizedResult = Omit<
  z.input<typeof completeCompanionImageProcessingInput>["result"],
  "outcome"
> & {
  outcome: z.input<typeof imageProcessingNormalizedOutcome>;
};

// Real HTTP admission, signed storage and cloud completion; only the external model
// response is seeded through its exact byte-fingerprint cache. Native ImageIO has
// separate real-decoder coverage. Originals, stale results and rewritable staging
// inputs must never change the preferred cloud snapshot.
test("companion normalization preserves originals and rejects stale or corrupt results", async ({
  request,
  page,
  e2eRuntime,
}) => {
  const workerOrigin = e2eRuntime.baseURL;
  const { db, actor } = await createEvidenceHarnessContext(page);
  const runId = await ensureRun(db, actor, { purpose: "background" });
  const database = getDb(db);
  await updateImageProcessingSettings(db, { enabled: false, paused: false });
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
      actualImageDescription: { available: false },
      jpegNormalization: { available: true, revision: 1 },
    },
  });
  async function post(path: string, input: CompanionRequest) {
    const response = await request.post(`/api/v1/imageProcessing/${path}`, {
      headers: { Origin: workerOrigin },
      data: input,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  async function seed() {
    const key = `synthetic/${randomUUID()}.avif`;
    expect(
      (
        await request.put(`${e2eRuntime.objectStorageUrl}/e2e-bucket/${key}`, {
          data: original,
          headers: { "Content-Type": "image/avif" },
        })
      ).ok(),
    ).toBe(true);
    const source = await createUploadedImageRecord(db, {
      key,
      filename: "synthetic-white.avif",
      contentType: "image/avif",
      size: original.length,
    });
    await database
      .update(image)
      .set({ sha256: hash(original), width: 2, height: 3 })
      .where(eq(image.id, source.id));
    const policy = preferredImageDescriptionPolicy;
    await saveImageDescriptionAnalysis(db, {
      imageId: parseEntityId("image", source.id),
      ...policy,
      inputFingerprint: imageDescriptionInputFingerprint({
        sourceContentHash: hash(original),
        contentType: "image/avif",
        provider: policy.provider,
        model: policy.model,
        renditionHash: hash(jpeg),
      }),
      result: {
        description: "A synthetic white rectangle",
        cutoutEligibility: "ineligible",
        claims: [],
        nutritionFacts: null,
      },
    });
    const scheduled = await scheduleImageProcessingJobs(db, {
      id: source.shortcode,
      kinds: ["describe_image"],
      publish: false,
      runId,
    });
    return { source, jobId: scheduled.jobIds[0] };
  }
  async function claim() {
    const response = pullCompanionImageProcessingOutput.parse(
      await post("pull", { hello }),
    );
    const command = response.command;
    if (command?.kind !== "describe_image" || !command.analysisOutput)
      throw new Error("Expected JPEG normalization assignment");
    return { command, output: command.analysisOutput };
  }
  async function stored(requestContext: APIRequestContext, key: string) {
    const response = await requestContext.get(
      `${e2eRuntime.objectStorageUrl}/e2e-bucket/${key}`,
    );
    expect(response.ok(), await response.text()).toBe(true);
    return response.body();
  }
  const { source, jobId } = await seed();
  // An old client without the additive capability must not lease AVIF work.
  const legacy = {
    ...hello,
    capabilities: { ...hello.capabilities, jpegNormalization: undefined },
  };
  expect(
    pullCompanionImageProcessingOutput.parse(
      await post("pull", { hello: legacy }),
    ).command,
  ).toBeNull();
  const { command, output } = await claim();
  expect(command.jobId).toBe(jobId);
  const [assigned] = await database
    .select()
    .from(imageProcessingAttempt)
    .where(eq(imageProcessingAttempt.id, command.attemptId));
  expect(assigned?.inputKey).toBe(output.key);
  expect(assigned?.executor?.deviceId).toBe(hello.deviceId);
  expect(await stored(request, source.key)).toEqual(original);
  expect(
    (
      await request.put(output.uploadUrl, {
        data: jpeg,
        headers: { "Content-Type": "image/jpeg" },
      })
    ).ok(),
  ).toBe(true);
  const result: NormalizedResult = {
    jobId: command.jobId,
    attemptId: command.attemptId,
    completedAt: new Date().toISOString(),
    outcome: {
      kind: "describe_image",
      status: "normalized",
      key: output.key,
      sha256: hash(jpeg),
      contentType: "image/jpeg",
      width: 2,
      height: 3,
    },
  };
  expect(
    completeCompanionImageProcessingOutput.parse(
      await post("complete", {
        deviceId: randomUUID(),
        result,
      }),
    ).adopted,
  ).toBe(false);
  expect(
    completeCompanionImageProcessingOutput.parse(
      await post("complete", {
        deviceId: hello.deviceId,
        result,
      }),
    ).adopted,
  ).toBe(true);
  expect(
    completeCompanionImageProcessingOutput.parse(
      await post("complete", {
        deviceId: hello.deviceId,
        result,
      }),
    ).adopted,
  ).toBe(false);
  const [finished] = await database
    .select()
    .from(imageProcessingAttempt)
    .where(eq(imageProcessingAttempt.id, command.attemptId));
  expect(finished?.state, finished?.error ?? "No attempt error").toBe("ready");
  // The runtime's own key prefix: a hardcoded `cubby/` key is unreachable
  // through the public URL of any other deployment.
  expect(finished?.inputKey).toMatch(/^e2e\/analysis-inputs\//);
  expect(finished?.inputKey).not.toBe(output.key);
  expect(finished?.diagnostics).toMatchObject({
    cached: true,
    renditionHash: hash(jpeg),
  });
  if (!finished?.inputKey) throw new Error("Saved analysis snapshot missing");
  // A late signed PUT can change staging, but never the model's immutable input.
  expect(
    (
      await request.put(output.uploadUrl, {
        data: Buffer.from("late upload"),
        headers: { "Content-Type": "image/jpeg" },
      })
    ).ok(),
  ).toBe(true);
  expect(await stored(request, finished.inputKey)).toEqual(jpeg);
  expect(await stored(request, source.key)).toEqual(original);
  const [preserved] = await database
    .select()
    .from(image)
    .where(eq(image.id, source.id));
  expect(preserved).toMatchObject({
    key: source.key,
    sha256: hash(original),
    contentType: "image/avif",
  });

  // Storage checksum errors are durable failures, with only the owning attempt
  // allowed to complete; an expired result cannot even adopt valid bytes.
  await seed();
  const invalid = await claim();
  expect(
    (
      await request.put(invalid.output.uploadUrl, {
        data: jpeg,
        headers: { "Content-Type": "image/jpeg" },
      })
    ).ok(),
  ).toBe(true);
  const corruptResult = {
    ...result,
    jobId: invalid.command.jobId,
    attemptId: invalid.command.attemptId,
    outcome: {
      ...result.outcome,
      key: invalid.output.key,
      sha256: "0".repeat(64),
    },
  };
  expect(
    completeCompanionImageProcessingOutput.parse(
      await post("complete", {
        deviceId: hello.deviceId,
        result: corruptResult,
      }),
    ).adopted,
  ).toBe(true);
  const [failed] = await database
    .select()
    .from(imageProcessingAttempt)
    .where(eq(imageProcessingAttempt.id, invalid.command.attemptId));
  expect(failed?.state).toBe("failed");
  expect(failed?.error).toContain("does not match");
  await seed();
  const expired = await claim();
  await database
    .update(imageProcessingJob)
    .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
    .where(eq(imageProcessingJob.id, expired.command.jobId));
  expect(
    completeCompanionImageProcessingOutput.parse(
      await post("complete", {
        deviceId: hello.deviceId,
        result: {
          ...result,
          jobId: expired.command.jobId,
          attemptId: expired.command.attemptId,
          outcome: { ...result.outcome, key: expired.output.key },
        },
      }),
    ).adopted,
  ).toBe(false);
});
