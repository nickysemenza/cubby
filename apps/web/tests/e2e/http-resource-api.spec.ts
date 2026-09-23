import { z } from "zod";
import { expect, test } from "./e2e-test";

const createdSchema = z.object({ item: z.object({ id: z.string() }) });

test("Scalar sends session-authenticated reads and writes without an API key", async ({
  page,
  baseURL,
}) => {
  await page.goto("/api/v1/docs#tag/dashboard/GET/api/v1/dashboard/counts");
  await page
    .getByRole("button", {
      name: "Test Request (get /api/v1/dashboard/counts)",
      exact: true,
    })
    .click();
  const read = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/dashboard/counts") &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: /^Send get request/ }).click();
  const result = await read;
  expect(result.request().headers()["x-api-key"]).toBeUndefined();
  expect(Boolean((await result.request().allHeaders()).cookie)).toBe(true);
  expect(result.status(), await result.text()).toBe(200);
  await page.goto("/api/v1/docs#tag/vendor/POST/api/v1/vendors");
  await page.reload();
  await page
    .getByRole("button", {
      name: "Test Request (post /api/v1/vendors)",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "API Client" })
    .getByRole("textbox", { name: "", exact: true })
    .first()
    .fill(JSON.stringify({ name: "Scalar session vendor" }));
  const snippet = page
    .getByRole("dialog", { name: "API Client" })
    .getByRole("region")
    .filter({ has: page.getByRole("heading", { name: /^Code Snippet/ }) })
    .last();
  await snippet.getByRole("button").click();
  await expect(snippet).toContainText("Scalar session vendor");
  const write = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/vendors") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /^Send post request/ }).click();
  const created = await write;
  expect((await created.request().allHeaders()).origin).toBe(baseURL);
  expect(created.status(), await created.text()).toBe(201);
  const id = createdSchema.parse(await created.json()).item.id;
  await page.request.delete(`/api/v1/vendors/${id}`, {
    headers: { Origin: baseURL! },
  });
});
