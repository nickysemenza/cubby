import { eq, and } from "drizzle-orm";
import {
  image,
  aiAnalysis,
  entityAttachment,
  imageProcessingJob,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createImageProcessingJob,
  IMAGE_IDENTIFICATION_PROCESSOR_REVISION,
  saveImageDescriptionAnalysis,
} from "~/server/repo/image-processing";
import { imageDescriptionInputFingerprint } from "~/server/services/image-description.service";
import { preferredImageDescriptionPolicy } from "~/server/image-processing/description-policy";
import {
  IMAGE_IDENTIFICATION_MODEL,
  IMAGE_IDENTIFICATION_PROMPT_REVISION,
  IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-identification";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { writeOutcomeReceipts } from "~/server/purchase-import/run-outcome.fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { getFixtureDb, fixtureUserId } from "./fixtures-core";
import { seedImagePrerequisite } from "./fixtures-photos";
import { seedProductPrerequisite } from "./fixtures-catalog";

// New device prose must not displace preferred cloud prose; identity observations never attach automatically.
test("image results compare descriptions and require explicit attachment confirmation", async ({
  page,
  e2eRuntime,
}) => {
  const source = await seedImagePrerequisite(
    "synthetic-image-understanding",
    e2eRuntime.objectStorageUrl,
  );
  const target = await seedProductPrerequisite(page, {
    name: "Synthetic utility jacket",
  });
  const db = getFixtureDb();
  const [row] = await getDb(db)
    .select()
    .from(image)
    .where(eq(image.shortcode, source.id));
  if (!row?.sha256) throw new Error("Synthetic source missing");
  const imageId = parseEntityId("image", row.id);
  for (const entry of [
    {
      ...preferredImageDescriptionPolicy,
      description: "Detailed cloud observation of a blue utility jacket.",
    },
    {
      ...preferredImageDescriptionPolicy,
      provider: "apple",
      model: "SystemLanguageModel.default",
      description: "Short Apple observation.",
    },
  ]) {
    await saveImageDescriptionAnalysis(db, {
      imageId,
      ...entry,
      inputFingerprint: imageDescriptionInputFingerprint({
        sourceContentHash: row.sha256,
        contentType: row.contentType,
        ...entry,
      }),
      result: {
        description: entry.description,
        claims: [],
        cutoutEligibility: "review",
      },
    });
  }
  const history = await insertWithShortcode(db, "run", {
    actorUserId: await fixtureUserId(page),
    actorName: "Fixture member",
    actorEmail: "fixture@example.test",
    purpose: "background",
    trigger: "manual",
    status: "completed",
  });
  await writeOutcomeReceipts(db, [
    {
      runId: parseEntityId("run", history.id),
      entityKind: "email",
      entityId: crypto.randomUUID(),
      state: "completed",
      targetFingerprint: "a".repeat(64),
    },
  ]);
  const jobId = await createImageProcessingJob(db, {
    imageId,
    kind: "identify_image",
    sourceContentHash: row.sha256,
    processorRevision: IMAGE_IDENTIFICATION_PROCESSOR_REVISION,
  });
  if (!jobId) throw new Error("Synthetic image job missing");
  await page.clock.install();
  await gotoAuthenticatedPage(page, `/images/${source.id}`);
  const description = page.getByRole("region", {
    name: "Selected image description",
  });
  await expect(
    description
      .getByText("Detailed cloud observation of a blue utility jacket.", {
        exact: true,
      })
      .filter({ visible: true }),
  ).toBeVisible();
  await description
    .getByText("Compare Apple and cloud descriptions", { exact: true })
    .click();
  await expect(
    description.getByText("Short Apple observation.", { exact: true }),
  ).toBeVisible();
  const identification = page.getByRole("region", {
    name: "Product identification",
  });
  await expect(
    identification.getByText(
      "No current identification result. Queue missing processing to evaluate this image.",
      { exact: true },
    ),
  ).toBeVisible();
  await getDb(db)
    .insert(aiAnalysis)
    .values({
      entityKind: "image",
      entityId: row.id,
      feature: "image-identification",
      provider: "cloudflare",
      model: IMAGE_IDENTIFICATION_MODEL,
      promptVersion: String(IMAGE_IDENTIFICATION_PROMPT_REVISION),
      resultSchemaRevision: IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION,
      inputFingerprint: JSON.stringify({
        feature: "image-identification",
        sourceContentHash: row.sha256,
      }),
      result: {
        subject: "multiple_objects",
        identityScope: "single_identity",
        category: "Clothing",
        outcome: "suggestions",
        candidates: [
          {
            productId: target.id,
            name: "Synthetic utility jacket",
            probability: 0.8,
          },
        ],
        considered: 1,
        truncated: false,
      },
    });
  await getDb(db)
    .update(imageProcessingJob)
    .set({ state: "ready", lastError: null, completedAt: new Date() })
    .where(eq(imageProcessingJob.id, jobId));
  await page.clock.fastForward(15_000);
  await expect(
    identification.getByRole("button", {
      name: "Confirm and attach",
      exact: true,
    }),
  ).toBeVisible();
  const attachments = () =>
    getDb(db)
      .select()
      .from(entityAttachment)
      .where(
        and(
          eq(entityAttachment.imageId, row.id),
          eq(entityAttachment.entityKind, "product"),
        ),
      );
  expect(await attachments()).toHaveLength(0);
  await identification
    .getByRole("button", { name: "Confirm and attach", exact: true })
    .click();
  await expect.poll(async () => (await attachments()).length).toBe(1);
  await expect(
    identification.getByRole("button", {
      name: "Already attached",
      exact: true,
    }),
  ).toBeDisabled();
  await description.scrollIntoViewIfNeeded();
  await expectViewportBounded(page);
  await page.screenshot({ path: "/tmp/cubby-image-results-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectViewportBounded(page);
  await description.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/cubby-image-results-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 900 });
  // The Image's generic "Image jobs" section opens the job's own record.
  await page
    .getByRole("link", { name: /^Image identification · / })
    .first()
    .click();
  await expect(page).toHaveURL(/\/image-jobs\/IPR-[A-Z0-9]{5}$/);
  await expect(page.locator("#attempts")).toBeVisible();
});
