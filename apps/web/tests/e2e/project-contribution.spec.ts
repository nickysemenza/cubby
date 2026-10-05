import { gotoAuthenticatedPage, uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { seedProjectContributionPrerequisite } from "./fixtures-finance";

test("project contribution shows credits as a negative adjustment, both party lists, and linked attribution gaps", async ({
  page,
}, testInfo) => {
  const name = uniqueName(
    testInfo,
    "Synthetic contribution project with a deliberately long party name",
  );
  const { project, member, guestName, unfunded } =
    await seedProjectContributionPrerequisite(page, name);
  await gotoAuthenticatedPage(page, `/projects/${project.id}`);

  const contribution = page.locator("section#contribution");
  await expect(contribution.getByText("Whole-group cost")).toBeVisible();
  await expect(
    contribution.getByText("Whole-group cost").locator("xpath=.."),
  ).toContainText("$120.44");
  // A credit (a negative-cost expense) reduces spend on every client.
  const credits = contribution.getByText("Credits", { exact: true });
  await expect(credits.locator("xpath=..")).toContainText(/[-−]\$20\.13/);

  // Beneficiaries split 3:1 across both party kinds; credits net in.
  const beneficiaries = contribution.getByRole("region", {
    name: "Beneficiaries",
  });
  await expect(beneficiaries.getByText(member.name)).toBeVisible();
  await expect(beneficiaries).toContainText("Member");
  await expect(beneficiaries.getByText(guestName)).toBeVisible();
  await expect(beneficiaries).toContainText("Guest");
  await expect(beneficiaries).toContainText("$90.33");
  await expect(beneficiaries).toContainText("$30.11");

  const funders = contribution.getByRole("region", {
    name: "Original funders",
  });
  await expect(funders.getByText(member.name)).toBeVisible();
  await expect(funders).toContainText("$80.36");
  await expect(funders.getByText(guestName)).toHaveCount(0);

  await page.setViewportSize({ width: 402, height: 874 });
  // Linked party names must fit alongside exact amounts at phone width.
  for (const region of [beneficiaries, funders]) {
    const bounds = await region.evaluate((element) => {
      const regionBox = element.getBoundingClientRect();
      return [...element.querySelectorAll("li a")].map((link) => {
        const box = link.getBoundingClientRect();
        const amountBox = link
          .closest("li")
          ?.lastElementChild?.getBoundingClientRect();
        return {
          right: box.right,
          regionRight: regionBox.right,
          amountLeft: amountBox?.left,
        };
      });
    });
    expect(bounds.length).toBeGreaterThan(0);
    for (const boundsEntry of bounds) {
      expect(boundsEntry.right).toBeLessThanOrEqual(
        boundsEntry.regionRight + 1,
      );
      expect(boundsEntry.amountLeft).toBeDefined();
      expect(boundsEntry.right).toBeLessThanOrEqual(
        boundsEntry.amountLeft ?? 0,
      );
    }
  }

  const gaps = contribution.getByRole("region", { name: "Attribution gaps" });
  await expect(
    gaps.getByRole("columnheader", { name: "Amount" }),
  ).toBeVisible();
  await expect(gaps).toContainText("$40.08");
  await expect(gaps.getByRole("link", { name: unfunded.id })).toHaveAttribute(
    "href",
    `/expenses/${unfunded.id}`,
  );
});
