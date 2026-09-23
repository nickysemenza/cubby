import { z } from "zod";
import { createCubbyClient } from "~/lib/http-api/client";
import { expect, test } from "./e2e-test";

const keyResult = z.object({
  id: z.string(),
  key: z.string(),
  referenceId: z.string(),
});

test("Scalar renders generated operations and account settings expose API keys", async ({
  page,
  baseURL,
}) => {
  await page.goto("/api/v1/docs");
  await expect(
    page.getByText("Cubby API", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open Group - dashboard", exact: true })
    .click();
  await expect(
    page.getByText("/api/v1/dashboard/counts", { exact: false }).first(),
  ).toBeVisible();
  await page.goto("/account/api-keys");
  await expect(
    page.getByRole("button", { name: "Create API Key", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create API Key", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Scalar acceptance");
  const createdKey = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api-key/create") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create API Key", exact: true })
    .click();
  const response = await createdKey;
  expect(response.status()).toBe(200);
  const key = keyResult.parse(await response.json());
  expect(key.key).toMatch(/^cubby_/u);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByText("Scalar acceptance", { exact: true }),
  ).toBeVisible();
  await page.goto("/api/v1/docs#tag/dashboard/GET/api/v1/dashboard/counts");
  await page
    .getByRole("button", {
      name: "Test Request (get /api/v1/dashboard/counts)",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "API Client" })
    .getByRole("button", {
      name: "Selected Auth Type: sessionCookie",
      exact: true,
    })
    .click();
  await page.getByText("apiKey", { exact: true }).last().click();
  await page
    .getByRole("dialog", { name: "API Client" })
    .getByRole("textbox", { name: "Value", exact: true })
    .fill(key.key);
  const sent = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/dashboard/counts") &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: /^Send get request/ }).click();
  expect((await sent).status()).toBe(200);
  await page.reload();
  await page
    .getByRole("button", {
      name: "Test Request (get /api/v1/dashboard/counts)",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "API Client" })
    .getByRole("button", {
      name: "Selected Auth Type: sessionCookie",
      exact: true,
    })
    .click();
  await page.getByText("apiKey", { exact: true }).last().click();
  await expect(
    page
      .getByRole("dialog", { name: "API Client" })
      .getByRole("textbox", { name: "Value", exact: true }),
  ).toHaveValue("");
  await page.goto("/account/api-keys");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(
    page.getByText("Scalar acceptance", { exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await createCubbyClient({
        baseUrl: baseURL!,
        apiKey: key.key,
      }).dashboard.counts({ query: {} })
    ).status,
  ).toBe(401);
});
