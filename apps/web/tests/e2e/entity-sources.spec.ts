import { resolveEntityIdentity } from "~/server/repo/entity-identity";
import { recordEntitySources } from "~/server/repo/entity-source";
import {
  seedProductPrerequisite,
  seedVendorDisplayPrerequisite,
} from "./fixtures-catalog";
import { createEvidenceHarnessContext } from "./fixtures-core";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Internal evidence must navigate as a record and group its field citations without losing quotes.
test("Sources group internal citations and open their entity", async ({
  page,
}) => {
  const product = await seedProductPrerequisite(page, {
    name: "Synthetic sourced tool",
  });
  const vendor = await seedVendorDisplayPrerequisite(
    page,
    "Synthetic source publisher",
  );
  const { db, actor } = await createEvidenceHarnessContext(page);
  const identity = await resolveEntityIdentity(db, product.id);
  if (identity.state !== "live")
    throw new Error("Synthetic product identity missing");
  await recordEntitySources(db, {
    entityKind: "product",
    entityId: identity.id,
    recorder: actor,
    detail: { name: "Synthetic sourced tool", manufacturer: "E2E fixture" },
    sources: [
      {
        fieldPath: "name",
        sourceEntity: vendor.id,
        quote: "Synthetic tool identity.",
      },
      {
        fieldPath: "manufacturer",
        sourceEntity: vendor.id,
        quote: "Synthetic maker evidence.",
      },
      {
        url: "https://example.test/specification",
        quote: "Synthetic public specification.",
      },
    ],
  });
  await gotoAuthenticatedPage(page, `/products/${product.id}`);
  const section = page.locator("#sources");
  await section.scrollIntoViewIfNeeded();
  const link = section.getByRole("link", {
    name: "Synthetic source publisher",
  });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", `/vendors/${vendor.id}`);
  // Two documents: each one's citations start folded under their count.
  await section.getByText("2 citations").click();
  await expect(section.getByText("Synthetic tool identity.")).toBeVisible();
  await expect(section.getByText("Synthetic maker evidence.")).toBeVisible();
  await expect(
    section.locator('a[href="https://example.test/specification"]'),
  ).toHaveAttribute("target", "_blank");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(link).toBeVisible();
  await expect(section.getByText("Synthetic maker evidence.")).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/vendors/${vendor.id}`));
});
