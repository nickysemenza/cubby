import { z } from "zod";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";

import * as schema from "~/server/db/schema";
import { png } from "~/server/purchase-import/purchase-research-journey.fixtures";
import { getDb } from "~/server/repo/database-helpers";

import { seedProductPrerequisite } from "./fixtures-catalog";
import { getFixtureDb } from "./fixtures-core";
import { seedMailImportReportRun } from "./fixtures-photos";
import {
  expectViewportBounded,
  gotoAuthenticatedPage,
  uniqueName,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("retained captures open beside their accepted facts with bounded navigation and protected originals", async ({
  page,
  browser,
  e2eRuntime,
}) => {
  const name = uniqueName(test.info(), "Capture results");
  const code = await seedMailImportReportRun(page, name);
  const product = await seedProductPrerequisite(page, {
    name: `${name} Product`,
  });
  const db = getDb(getFixtureDb());
  const [owner] = await db
    .select()
    .from(schema.run)
    .where(eq(schema.run.shortcode, code));
  const [subject] = await db
    .select()
    .from(schema.product)
    .where(
      eq(schema.product.shortcode, parseShortcodeFor("product", product.id)),
    );
  if (!owner || !subject) throw new Error("Synthetic capture subjects missing");
  const [target] = await db
    .insert(schema.runTarget)
    .values({
      runId: owner.id,
      entityKind: "product",
      entityId: subject.id,
      workKey: "synthetic-capture-results",
      state: "completed",
      targetFingerprint: "synthetic-capture-results",
      outcome: "verified",
    })
    .returning();
  if (!target) throw new Error("Synthetic capture target missing");
  const checksum = await sha256Hex(png);
  for (let index = 0; index < 13; index++) {
    const key = `e2e/retained-capture/${owner.id}/${index}.png`;
    const stored = await fetch(
      `${e2eRuntime.objectStorageUrl}/e2e-bucket/${encodeURIComponent(key)}`,
      { method: "PUT", headers: { "Content-Type": "image/png" }, body: png },
    );
    expect(stored.ok).toBe(true);
    const [screenshot] = await db
      .insert(schema.runEvidence)
      .values({
        runId: owner.id,
        targetId: target.id,
        kind: "browser_capture",
        objectKey: key,
        checksum,
        mediaType: "image/png",
        byteSize: png.byteLength,
        sourceMetadata: {},
      })
      .returning();
    if (!screenshot) throw new Error("Synthetic screenshot missing");
    const retainedPage = "Synthetic retained page";
    const storedPage = await fetch(
      `${e2eRuntime.objectStorageUrl}/e2e-bucket/${encodeURIComponent(`${key}.html`)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "text/html" },
        body: retainedPage,
      },
    );
    expect(storedPage.ok).toBe(true);
    const [source] = await db
      .insert(schema.runEvidence)
      .values({
        runId: owner.id,
        targetId: target.id,
        kind: "browser_capture",
        objectKey: `${key}.html`,
        checksum: await sha256Hex(retainedPage),
        mediaType: "text/html",
        byteSize: new TextEncoder().encode(retainedPage).byteLength,
        sourceMetadata: {
          title: `Captured page ${index + 1}`,
          sourceURL: `https://shop.example.test/orders/${index + 1}`,
          capturedAt: new Date(Date.UTC(2026, 8, 1, 18, index)).toISOString(),
          screenshots: [
            {
              id: screenshot.id,
              kind: "screenshot",
              checksum,
              contentType: "image/png",
            },
          ],
        },
      })
      .returning();
    if (!source) throw new Error("Synthetic source page missing");
    const value = index % 2 ? subject.name : subject.manufacturer;
    await db.insert(schema.runFactEvidence).values({
      targetId: target.id,
      evidenceId: source.id,
      entityKind: "product",
      entityId: subject.id,
      fieldPath: index % 2 ? "name" : "manufacturer",
      value,
      valueFingerprint: await sha256Hex(JSON.stringify(value)),
      support: {
        observation: `Synthetic published ${index % 2 ? "name" : "manufacturer"}: ${value}`,
        reasoning:
          "Synthetic fixture binds this original to the selected Product.",
      },
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(page, `/runs/${code}`);
  const captures = page.getByRole("region", { name: "Captured pages" });
  await expect(captures).toBeVisible();
  await expect(
    captures.getByRole("button", { name: /^View Captured page / }),
  ).toHaveCount(8);
  await captures
    .getByRole("button", { name: "Next captures", exact: true })
    .click();
  await captures
    .getByRole("button", { name: "View Captured page 2", exact: true })
    .click();
  const selected = captures.getByRole("region", { name: "Selected record" });
  await expect(
    selected.getByText("Captured page 2", { exact: true }),
  ).toBeVisible();
  await expect(
    selected.getByText(`name: ${subject.name}`, { exact: false }),
  ).toBeVisible();
  await expect(
    selected.locator(`a[href='/products/${product.id}']`),
  ).toBeVisible();
  await expect(
    selected.getByRole("link", { name: "Open live source", exact: true }),
  ).toHaveAttribute("href", "https://shop.example.test/orders/2");
  const image = selected.getByRole("img", {
    name: "Captured page 2",
    exact: true,
  });
  await expect
    .poll(() =>
      image.evaluate(
        (node) =>
          node instanceof HTMLImageElement &&
          node.complete &&
          node.naturalWidth > 0,
      ),
    )
    .toBe(true);
  const mediaUrl = await image.getAttribute("src");
  if (!mediaUrl) throw new Error("Selected capture has no protected media URL");
  const original = await page.request.get(mediaUrl);
  expect(original.status()).toBe(200);
  const cacheControl = original.headers()["cache-control"];
  if (!cacheControl) throw new Error("Protected media omitted cache policy");
  expect(cacheControl.split(",").map((directive) => directive.trim())).toEqual(
    expect.arrayContaining(["private", "no-store"]),
  );
  expect(await original.body()).toEqual(png);
  const invalidCredentials: Record<string, string>[] = [
    { Authorization: "Bearer invalid-synthetic-token" },
    { "x-api-key": "invalid-synthetic-key" },
  ];
  for (const headers of invalidCredentials) {
    expect((await page.request.get(mediaUrl, { headers })).status()).toBe(401);
  }
  const anonymous = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const denied = await anonymous.request.get(
      new URL(mediaUrl, page.url()).href,
    );
    expect(denied.status()).toBe(401);
    const keyResponse = await page.request.post("/api/auth/api-key/create", {
      data: { name: "Retained media acceptance", configId: "http-api" },
      headers: { Origin: new URL(page.url()).origin },
    });
    expect(keyResponse.status()).toBe(200);
    const key = z
      .object({ id: z.string(), key: z.string() })
      .parse(await keyResponse.json());
    try {
      const admitted = await anonymous.request.get(
        new URL(mediaUrl, page.url()).href,
        {
          headers: { "x-api-key": key.key },
        },
      );
      expect(admitted.status()).toBe(200);
      expect(await admitted.body()).toEqual(png);
    } finally {
      expect(
        (
          await page.request.post("/api/auth/api-key/delete", {
            data: { keyId: key.id, configId: "http-api" },
            headers: { Origin: new URL(page.url()).origin },
          })
        ).status(),
      ).toBe(200);
    }
  } finally {
    await anonymous.close();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    selected.getByText("Captured page 2", { exact: true }),
  ).toBeVisible();
  await expectViewportBounded(page);
  await db
    .update(schema.run)
    .set({ retiredAt: new Date(), retirementReason: "unrelated_source" })
    .where(eq(schema.run.id, owner.id));
  expect((await page.request.get(mediaUrl)).status()).toBe(404);
  const [unchanged] = await db
    .select()
    .from(schema.product)
    .where(eq(schema.product.id, subject.id));
  expect(unchanged?.name).toBe(subject.name);
  expect(unchanged?.manufacturer).toBe(subject.manufacturer);
});
