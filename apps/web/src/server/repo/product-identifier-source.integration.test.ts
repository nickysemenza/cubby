import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { externalSource } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { resolveProductIdentifierSource } from "~/server/repo/product-identifier-source";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

// Registry ownership is a DB boundary: name-only registrations cannot authorize
// a host, and competing or incompatible bindings must leave historical rows alone.
describe("Product identifier issuer registry", () => {
  const ctx = withTestDb();
  it("reuses the sole explicitly bound source for canonical domain aliases and URL-less orders", async () => {
    const issuer = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example canonical retailer",
      website: "https://example.test",
      browserDomains: ["catalog.example.test"],
    });
    await getDb(ctx.db).insert(externalSource).values({
      slug: "retained-catalog",
      label: "Example catalog",
      vendorId: issuer.id,
    });
    for (const url of [
      "https://www.example.test/p/1",
      "https://catalog.example.test/p/2",
      undefined,
    ]) {
      expect(
        await resolveProductIdentifierSource(ctx.db, {
          url,
          vendorId: issuer.id,
        }),
      ).toBe("retained-catalog");
    }
  });
  it("preserves unowned legacy prefixes and distinguishes punctuation in full hosts", async () => {
    await getDb(ctx.db)
      .insert(externalSource)
      .values({ slug: "shop", label: "Legacy shop" });
    const first = await resolveProductIdentifierSource(ctx.db, {
      url: "https://shop.alpha.example.test/p/1",
    });
    const second = await resolveProductIdentifierSource(ctx.db, {
      url: "https://shop-alpha.example.test/p/1",
    });
    expect(first).toBe("host-73686f702e616c7068612e6578616d706c652e74657374");
    expect(second).toBe("host-73686f702d616c7068612e6578616d706c652e74657374");
    expect(
      await getDb(ctx.db)
        .select()
        .from(externalSource)
        .where(eq(externalSource.slug, "shop")),
    ).toMatchObject([{ vendorId: null }]);
  });
  it("refuses ambiguous canonical domain ownership", async () => {
    for (const name of ["Example first retailer", "Example second retailer"]) {
      await insertWithShortcode(ctx.db, "vendor", {
        name,
        website: "https://example.test",
      });
    }
    await expect(
      resolveProductIdentifierSource(ctx.db, {
        url: "https://example.test/p/1",
      }),
    ).rejects.toThrow("ambiguous");
  });
  it("refuses competing sources for one canonical Vendor", async () => {
    const issuer = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example retailer",
      website: "https://example.test",
    });
    await getDb(ctx.db)
      .insert(externalSource)
      .values([
        { slug: "example-first", label: "First", vendorId: issuer.id },
        { slug: "example-second", label: "Second", vendorId: issuer.id },
      ]);
    await expect(
      resolveProductIdentifierSource(ctx.db, {
        url: "https://example.test/p/1",
      }),
    ).rejects.toThrow("competing");
  });
  it("refuses an encoded full-host registration bound to an incompatible Vendor", async () => {
    const other = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example other retailer",
      website: "https://other.test",
    });
    await getDb(ctx.db).insert(externalSource).values({
      slug: "host-6578616d706c652e74657374",
      label: "Conflicting registration",
      vendorId: other.id,
    });
    await expect(
      resolveProductIdentifierSource(ctx.db, {
        url: "https://example.test/p/1",
      }),
    ).rejects.toThrow("incompatible");
    expect(await getDb(ctx.db).select().from(externalSource)).toMatchObject([
      { vendorId: other.id },
    ]);
  });
});
