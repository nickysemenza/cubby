import { expect, test } from "./e2e-test";

// Unregistered scanner endpoints and incomplete deep links must retain their
// ordinary HTTP status instead of becoming server-error issue groups.
test("unknown API paths return not found", async ({ request }) => {
  for (const path of [
    "/api/gql",
    "/graphql/api",
    "/api/graphql",
    "/api",
    "/graphql",
    "/v2/_catalog",
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
  }
});

test("incomplete deep links render without a server error", async ({
  page,
}) => {
  const connections = await page.goto("/connections");
  expect(connections?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Unknown connection view" }),
  ).toBeVisible();

  const workbench = await page.goto("/recommendations/workbench");
  expect(workbench?.status()).toBe(200);
  await expect(
    page.getByText("Open this workbench from a current recommendation."),
  ).toBeVisible();
});
