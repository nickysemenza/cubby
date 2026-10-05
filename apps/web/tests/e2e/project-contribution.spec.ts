import { gotoAuthenticatedPage, uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { seedProjectContributionPrerequisite } from "./fixtures-finance";

test("project contribution shows credits as a negative adjustment, both party lists, and linked attribution gaps", async ({
  page,
}, testInfo) => {
  const name = uniqueName(testInfo, "Synthetic contribution project");
  const { project, member, guestName, unfunded } =
    await seedProjectContributionPrerequisite(page, name);
  await gotoAuthenticatedPage(page, `/projects/${project.id}`);

  const contribution = page.locator("section#contribution");
  await expect(contribution.getByText("Whole-group cost")).toBeVisible();
  // A credit (a negative-cost expense) reduces spend on every client.
  const credits = contribution.getByText("Credits", { exact: true });
  await expect(credits.locator("xpath=..")).toContainText(/[-−]\$20/);

  // Beneficiaries split 3:1 across both party kinds; credits net in.
  const beneficiaries = contribution.getByRole("region", {
    name: "Beneficiaries",
  });
  await expect(beneficiaries.getByText(member.name)).toBeVisible();
  await expect(beneficiaries).toContainText("Member");
  await expect(beneficiaries.getByText(guestName)).toBeVisible();
  await expect(beneficiaries).toContainText("Guest");
  await expect(beneficiaries).toContainText("$90.00");
  await expect(beneficiaries).toContainText("$30.00");

  const funders = contribution.getByRole("region", {
    name: "Original funders",
  });
  await expect(funders.getByText(member.name)).toBeVisible();
  await expect(funders).toContainText("$80.00");
  await expect(funders.getByText(guestName)).toHaveCount(0);

  const gaps = contribution.getByRole("region", { name: "Attribution gaps" });
  await expect(
    gaps.getByRole("columnheader", { name: "Amount" }),
  ).toBeVisible();
  await expect(gaps).toContainText("$40.00");
  await expect(gaps.getByRole("link", { name: unfunded.id })).toHaveAttribute(
    "href",
    `/expenses/${unfunded.id}`,
  );
});
