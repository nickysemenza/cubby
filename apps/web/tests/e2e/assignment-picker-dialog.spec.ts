import { chooseListView } from "./e2e-helpers";
import { z } from "zod";

import { escapeRegExp, gotoAuthenticatedPage, uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { seedLocationPrerequisite } from "./fixtures-catalog";

const locationParentOut = z.object({
  parent: z.object({ id: z.string(), name: z.string() }).nullable(),
});

/**
 * The assignment-dialog picker lifecycle (`ui/form-utils/entity-value-field.tsx`),
 * driven through the bulk "Move under..." dialog. Failure modes: a selected
 * label degrades to its bare shortcode once the picker's search results stop
 * listing it (search away, or a just-created record the results never held);
 * clearing leaves a stale value that still submits; a cleared required field
 * submits instead of naming the missing choice; the write moves to the wrong
 * parent.
 */
test("an assignment picker keeps its label through search, clear, and create", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const token = uniqueName(testInfo, "Picker guard");
  const childNames = [`${token} child one`, `${token} child two`];
  const children = await Promise.all(
    childNames.map((name) => seedLocationPrerequisite(page, name)),
  );
  const parentName = `${token} chosen parent`;
  await seedLocationPrerequisite(page, parentName);
  const createdName = `${token} created parent`;

  await gotoAuthenticatedPage(
    page,
    `/locations?name=${encodeURIComponent(`${token} child`)}`,
  );
  await chooseListView(page, "List");
  for (const name of childNames) {
    await page
      .getByRole("row")
      .filter({ hasText: name })
      .getByRole("checkbox", { name: "Select row" })
      .click();
  }
  await page
    .locator("[data-bulk-action-bar]")
    .getByRole("button", { name: "Move under...", exact: true })
    .click();

  const dialog = page.getByRole("dialog", {
    name: "Move 2 Locations?",
    exact: true,
  });
  const picker = dialog.getByRole("combobox", {
    name: "New Parent Location",
    exact: true,
  });
  // The effect list projects the chosen parent's label onto every row.
  const effectTargets = (name: string) =>
    dialog.getByText(name, { exact: true });

  // Select.
  await picker.click();
  await picker.fill(parentName);
  await page
    .getByRole("option", { name: new RegExp(`^${escapeRegExp(parentName)}`) })
    .click();
  await expect(picker).toHaveValue(`${parentName} — room`);
  await expect(effectTargets(parentName)).toHaveCount(2);

  // Search away: results that no longer list the selection must not erase
  // its label from the closed input or the effect list.
  // Location search matches any token, so the miss shares none with the seeds.
  const missing = "Zzyzxq";
  await picker.click();
  await picker.fill(missing);
  await expect(page.getByText("No location found.")).toBeVisible();
  await picker.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(page.getByText("No location found.")).toHaveCount(0);
  await expect(picker).toHaveValue(`${parentName} — room`);
  await expect(effectTargets(parentName)).toHaveCount(2);

  // Clear: nothing stale remains, and submitting names the missing choice.
  await dialog
    .getByRole("button", { name: "Clear New Parent Location", exact: true })
    .click();
  await expect(picker).toHaveValue("");
  await expect(effectTargets(parentName)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Move locations" }).click();
  await expect(dialog.getByText("Please select a location")).toBeVisible();

  // Create from the picker: the new record becomes the selection with its own
  // label, though the typed search that offered it never listed it.
  await picker.click();
  await picker.fill(createdName);
  const createRow = page.getByRole("button", {
    name: `Create location: ${createdName}`,
    exact: true,
  });
  await expect(createRow).toBeVisible();
  await createRow.click();
  const createDialog = page.getByRole("dialog").filter({
    has: page.getByRole("button", { name: "Create", exact: true }),
  });
  await expect(
    createDialog.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue(createdName);
  await createDialog
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await expect(createDialog).toHaveCount(0);
  await expect(picker).toHaveValue(
    new RegExp(`^${escapeRegExp(createdName)}( — .+)?$`),
  );
  await expect(effectTargets(createdName)).toHaveCount(2);

  await dialog.getByRole("button", { name: "Move locations" }).click();
  await expect(dialog).toHaveCount(0);
  for (const child of children) {
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/v1/locations/${child.id}`,
        );
        return locationParentOut.parse(await response.json()).parent?.name;
      })
      .toBe(createdName);
  }
});
