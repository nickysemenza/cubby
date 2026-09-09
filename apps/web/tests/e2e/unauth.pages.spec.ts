import { expect, test } from "./e2e-test";

test("public home renders and protected detail redirects before rendering", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Cubby/i);

  await page.goto("/products/PRD-2222");
  await expect(page).toHaveURL(/\/auth\/sign-in/);
});

test("footer metadata is server rendered and reused across client navigation", async ({
  page,
}) => {
  const metadataRequests: string[] = [];
  const documentRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/_serverFn/") &&
      request.url().includes("build-metadata")
    )
      metadataRequests.push(request.url());
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documentRequests.push(request.url());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto("/auth/sign-in");
  expect(response).not.toBeNull();
  const html = await response!.text();
  const serverText = await page.evaluate((markup) => {
    const document = new DOMParser().parseFromString(markup, "text/html");
    return document
      .querySelector('[data-testid="build-metadata"]')
      ?.textContent?.replace(/\s+/g, " ")
      .trim();
  }, html);
  expect(serverText).toBeTruthy();
  const footer = page.getByTestId("build-metadata");
  await expect(footer).toHaveText(serverText!);

  await page.getByRole("link", { name: "Docs", exact: true }).click();
  await expect(page).toHaveURL(/\/docs(?:\/|$)/);
  await expect(footer).toHaveText(serverText!);
  await page.getByRole("link", { name: "Sign In", exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/sign-in/);
  await expect(footer).toHaveText(serverText!);
  expect(documentRequests).toHaveLength(1);
  expect(metadataRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
