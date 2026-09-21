import { expect, test } from "./e2e-test";

test("public home renders and protected detail redirects before rendering", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Cubby/i);

  await page.goto("/products/PRD-2222");
  await expect(page).toHaveURL(/\/auth\/sign-in/);
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.getByRole("button", { name: /google/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /passkey/i })).toHaveCount(0);
});

test("footer metadata is server rendered and reused across client navigation", async ({
  page,
}) => {
  const metadataRequests: string[] = [];
  const documentRequests: string[] = [];
  const pageErrors: string[] = [];
  // Caught-and-logged failures never reach `pageerror`: router-ssr-query-core
  // 1.169.1 swallowed a hydrate crash into `console.error` on every page load
  // and no gate saw it. Console errors fail here too.
  const consoleErrors: string[] = [];
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
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

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
  // SSR links work before hydration, but only hydrated links exercise client navigation.
  await expect(page.locator('[data-nav-hydrated="true"]')).toBeVisible();

  await page.getByRole("link", { name: "Docs", exact: true }).click();
  await expect(page).toHaveURL(/\/docs(?:\/|$)/);
  await expect(footer).toHaveText(serverText!);
  await page.getByRole("link", { name: "Sign In", exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/sign-in/);
  await expect(footer).toHaveText(serverText!);
  expect(documentRequests).toHaveLength(1);
  expect(metadataRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("anonymous OAuth registration lazily seeds the configured MCP resource", async ({
  request,
}) => {
  const response = await request.post("/api/auth/oauth2/register", {
    data: {
      application_type: "native",
      client_name: "Cubby E2E MCP Client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["http://127.0.0.1/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });

  expect(response.status()).toBe(201);
  expect(await response.json()).toMatchObject({
    resources: ["https://cubby.nickysemenza.com/api/mcp"],
  });
});
