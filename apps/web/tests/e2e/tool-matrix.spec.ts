import { waitForFormHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("tool matrix keeps angled project headers pinned below the nav", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);

  // Unique per ATTEMPT, and deliberately computed inside the test body rather
  // than at module scope. CI runs `retries: 2`, and these rows persist across
  // attempts — so with the old fixed names a timed-out attempt left its
  // projects behind, the retry created them again, and the `project=` prefix
  // filter below then matched 3-4 headers instead of 2. The retry failed on its
  // own leftovers rather than on the defect it was retrying, which is how this
  // test blocked merges on two unrelated PRs. A module-scope constant would
  // reintroduce exactly that, since every attempt shares it.
  const tag = `Matrix${Date.now()}x${testInfo.retry}`;
  const kitchen = `${tag} kitchen`;
  const garage = `${tag} garage`;
  const toolName = `${tag} track saw`;
  const manufacturer = `${tag} Tools`;

  for (const name of [kitchen, garage]) {
    await page.goto("/projects");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "New Project" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill(name);
    await dialog.getByRole("button", { name: /^Create$/ }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    if (name === kitchen) {
      await page.goto("/projects?view=gallery");
      await page.waitForLoadState("networkidle");
      await page.getByRole("link").filter({ hasText: name }).first().click();
      await expect(page).toHaveURL(
        /\/projects\/PRJ-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}/,
      );
      const iconRow = page.getByText("Icon", { exact: true }).locator("..");
      await iconRow.getByRole("button").first().click();
      const iconInput = page.getByPlaceholder("e.g. 🔧");
      await iconInput.fill("🛠️");
      const updateResponse = page.waitForResponse(
        (response) =>
          response.url().includes("project.update") && response.ok(),
      );
      await iconInput.press("Enter");
      await updateResponse;
      await expect(iconRow.getByText("🛠️")).toBeVisible();
    }
  }

  await page.goto("/products/new");
  await waitForFormHydration(page);
  await page.getByPlaceholder("Enter product name").fill(toolName);
  await page.getByPlaceholder("Enter manufacturer").fill(manufacturer);
  await page.getByPlaceholder("Select category").click();
  await page.getByRole("option", { name: "tools", exact: true }).click();
  await page.getByRole("button", { name: /^Create$/ }).click();
  await expect(page).toHaveURL(
    /\/products\/PRD-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}/,
    { timeout: 15000 },
  );

  await page.setViewportSize({ width: 1280, height: 300 });
  await page.goto(`/projects/tools?floor=0&project=${encodeURIComponent(tag)}`);
  await page.waitForLoadState("networkidle");

  const table = page.getByRole("table");
  await expect(table).toBeVisible({ timeout: 15000 });
  const projectLinks = table.locator("thead").getByRole("link");
  await expect(projectLinks).toHaveCount(2);
  await expect(projectLinks.first()).toHaveCSS("rotate", "-60deg");
  const customProject = projectLinks.filter({ hasText: kitchen });
  await expect(customProject.getByText("🛠️")).toBeVisible();
  const fallbackProject = projectLinks.filter({ hasText: garage });
  await expect(fallbackProject.locator("svg.lucide-hammer")).toBeVisible();

  const toolRow = table.getByRole("row").filter({
    has: page.getByRole("link", { name: toolName, exact: true }),
  });
  const toolRowText = await toolRow.innerText();
  expect(toolRowText.split(manufacturer).length - 1).toBe(1);

  const header = table.locator("thead");
  const initialTop = await header.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  await page.evaluate(
    (top) => window.scrollTo({ top: window.scrollY + top - 31 }),
    initialTop,
  );
  await expect
    .poll(() =>
      header.evaluate((element) =>
        Math.round(element.getBoundingClientRect().top),
      ),
    )
    .toBe(51);
});
