import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import { z } from "zod";

import { dashboardCountsOut } from "@cubby/schemas/dashboard";
import { foodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { productLookupResponseSchema } from "~/contracts/upc.schemas";

import { DEV_USER_EMAIL } from "../../tooling/dev/state";
import { expect, test } from "./hmr-test";

// Runtime contracts of the local development Worker that only a live `pnpm dev`
// session exposes: dev auth shortcuts mint real sessions, Vite HMR reaches the
// browser under workerd, the synthetic USDA release and UPC cache load, and
// local R2 serves signed, public and CDN paths from one object. The pure
// storage adapter contract lives in `tooling/dev/storage.unit.test.ts`.

const sessionUser = z.object({ user: z.object({ email: z.string() }) });

test("native development login returns a real signed bearer without redirecting", async ({
  request,
}) => {
  const login = await request.get("/__dev/login?native=true", {
    maxRedirects: 0,
  });
  expect(login.status()).toBe(200);
  expect(login.headers()["location"]).toBeUndefined();
  expect(login.headers()["cache-control"]).toBe("no-store");
  const token = login.headers()["set-auth-token"];
  expect(token).toBeTruthy();
  const session = await request.get("/api/auth/get-session", {
    headers: { Authorization: `Bearer ${token}`, Origin: "cubby-mobile://" },
  });
  expect(session.status()).toBe(200);
  expect(sessionUser.parse(await session.json()).user.email).toBe(
    DEV_USER_EMAIL,
  );
  expect((await request.post("/__dev/login?native=true")).status()).toBe(405);
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("home offers one-click development sign-in", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/auth\/sign-in$/u);
    await page
      .getByRole("link", { name: "Continue as local dev user" })
      .click();
    await expect(page).toHaveURL(/\/$/u);
    const session = await page.request.get("/api/auth/get-session");
    expect(sessionUser.parse(await session.json()).user.email).toBe(
      DEV_USER_EMAIL,
    );
  });
});

test("browser receives a Vite HMR update without navigation", async ({
  page,
  hmrSession,
}) => {
  const fixture = path.join(
    hmrSession.profile.stateDir,
    `hmr-probe-${randomUUID().slice(0, 8)}.ts`,
  );
  const moduleURL = `/@fs${fixture}`;
  const module = (value: string) =>
    `export const marker=${JSON.stringify(value)};\nif(import.meta.hot){ import.meta.hot.accept(next=>{ window.__cubbyHmrProbe=next.marker; }); }\n`;
  try {
    await page.goto("/");
    await writeFile(fixture, module("before"));
    expect(
      await page.evaluate(
        async (url) => (await import(/* @vite-ignore */ url)).marker,
        moduleURL,
      ),
    ).toBe("before");
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await writeFile(fixture, module("after"));
    await page.waitForFunction(() => window.__cubbyHmrProbe === "after");
    expect(navigations).toEqual([]);
  } finally {
    await rm(fixture, { force: true });
  }
});

test("the USDA release object and UPC cache serve their synthetic fixtures", async ({
  request,
}) => {
  const counts = await request.get("/api/v1/dashboard/counts");
  expect(counts.status()).toBe(200);
  const parsed = dashboardCountsOut.parse(await counts.json());
  expect(parsed.usdaFoodsAvailable).toBe(true);
  // Three foundation foods and one branded food (tooling/dev/usda-synthetic-release.ts).
  expect(parsed.usdaFoods).toBe(4);
  const food = await request.get("/api/v1/usda-food/detail?id=9900001");
  expect(food.status()).toBe(200);
  expect(
    foodSummaryWithLinkedProducts.parse(await food.json()).foodInfo.description,
  ).toBe("Synthetic rolled oats");

  const upc = await request.get("/api/v1/upc/lookup?upc=012345678905");
  expect(upc.status(), await upc.text()).toBe(200);
  const lookup = productLookupResponseSchema.parse(await upc.json());
  expect(lookup).toMatchObject({
    name: "Synthetic cotton shirt",
    upc: "012345678905",
  });
});

test("local R2 serves one dummy-signed upload through signed, public and CDN paths", async ({
  request,
  baseURL,
}) => {
  const key = `cubby-local/hmr-probe/${randomUUID()}.bin`;
  const objectPath = `/__local-storage/s3/cubby-local/${key}`;
  const bytes = "synthetic-original-bytes";
  // The SDK's expired dummy signature must still be accepted locally.
  const url = new URL(objectPath, baseURL);
  url.searchParams.set("X-Amz-Expires", "0");
  const signed = await new AwsClient({
    accessKeyId: "dummy",
    secretAccessKey: "dummy",
    service: "s3",
    region: "auto",
  }).sign(
    new Request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
    }),
    { aws: { signQuery: true, allHeaders: true } },
  );
  const upload = await request.put(signed.url, {
    headers: { "Content-Type": "application/octet-stream" },
    data: bytes,
  });
  expect(upload.status()).toBe(200);
  try {
    for (const pathname of [
      objectPath,
      `/${key}`,
      `/cdn-cgi/image/width=12,format=auto/${key}`,
    ]) {
      const read = await request.get(pathname, {
        headers: { "Accept-Encoding": "identity" },
      });
      expect(read.status(), pathname).toBe(200);
      expect(await read.text()).toBe(bytes);
      expect(read.headers()["content-type"]).toBe("application/octet-stream");
    }
    const head = await request.head(`/${key}`);
    expect(head.status()).toBe(200);
    expect(head.headers()["content-length"]).toBe(String(bytes.length));
  } finally {
    expect((await request.delete(objectPath)).status()).toBe(204);
  }
  expect((await request.get(`/${key}`)).status()).toBe(404);
});
