import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { entityExternalId, externalSource } from "~/server/db/schema";
import {
  lookupProductIdentifierSources,
  resolveProductIdentifierSource,
} from "~/server/domains/product/repo/product-identifier-source";
import { findProductIdentifiersOutsideIssuer } from "~/server/generic/problems/repo/detectors-product";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

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
      issuer: true,
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
    expect(
      await lookupProductIdentifierSources(ctx.db, [
        { url: "https://www.example.test/p/1" },
        { url: "https://catalog.example.test/p/2" },
        { vendorId: issuer.id },
        { url: "https://unregistered.example.test/p/3" },
        { url: "https://unregistered.invalid.test/p/4" },
      ]),
    ).toEqual(
      [
        "retained-catalog",
        "retained-catalog",
        "retained-catalog",
        "retained-catalog",
        null,
      ].map((source) => ({ source, error: null })),
    );
    expect(await getDb(ctx.db).select().from(externalSource)).toHaveLength(1);
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
      await lookupProductIdentifierSources(ctx.db, [
        { url: "https://shop.alpha.example.test/p/1" },
        { url: "https://shop-alpha.example.test/p/1" },
      ]),
    ).toEqual([
      { source: first, error: null },
      { source: second, error: null },
    ]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(externalSource)
        .where(eq(externalSource.slug, "shop")),
    ).toMatchObject([{ vendorId: null }]);
  });
  it("refuses ambiguous canonical domain ownership and names both Vendors", async () => {
    const vendors = [];
    for (const name of ["Example first retailer", "Example second retailer"])
      vendors.push(
        await insertWithShortcode(ctx.db, "vendor", {
          name,
          website: "https://example.test",
        }),
      );
    await expect(
      resolveProductIdentifierSource(ctx.db, {
        url: "https://example.test/p/1",
      }),
    ).rejects.toThrow("ambiguous");
    const [lookup] = await lookupProductIdentifierSources(ctx.db, [
      { url: "https://example.test/p/1" },
    ]);
    expect(lookup?.source).toBeNull();
    expect(lookup?.error).toContain("ambiguous");
    for (const row of vendors) expect(lookup?.error).toContain(row.shortcode);
  });
  // Regression: one Vendor owning a legacy slug beside its host registration
  // threw for every claim, failing the catalog-wide duplicate detector.
  it("resolves the flagged issuer beside the Vendor's export and legacy sources", async () => {
    const issuer = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example retailer",
      website: "https://example.test",
    });
    await getDb(ctx.db)
      .insert(externalSource)
      .values([
        { slug: "example-orders", label: "Orders", vendorId: issuer.id },
        {
          slug: "example-catalog",
          label: "Catalog",
          vendorId: issuer.id,
          issuer: true,
        },
      ]);
    expect(
      await resolveProductIdentifierSource(ctx.db, {
        url: "https://example.test/p/1",
      }),
    ).toBe("example-catalog");
    expect(
      await lookupProductIdentifierSources(ctx.db, [
        { url: "https://example.test/p/1" },
        { vendorId: issuer.id },
      ]),
    ).toEqual([
      { source: "example-catalog", error: null },
      { source: "example-catalog", error: null },
    ]);
  });
  it("registers the host issuer instead of reusing an owned export source", async () => {
    const issuer = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example retailer",
      website: "https://example.test",
    });
    await getDb(ctx.db)
      .insert(externalSource)
      .values({ slug: "example-orders", label: "Orders", vendorId: issuer.id });
    expect(
      await lookupProductIdentifierSources(ctx.db, [{ vendorId: issuer.id }]),
    ).toEqual([{ source: null, error: null }]);
    const registered = await resolveProductIdentifierSource(ctx.db, {
      vendorId: issuer.id,
    });
    expect(registered).toBe("host-6578616d706c652e74657374");
    expect(
      await getDb(ctx.db)
        .select({ slug: externalSource.slug, issuer: externalSource.issuer })
        .from(externalSource)
        .orderBy(externalSource.slug),
    ).toEqual([
      { slug: "example-orders", issuer: false },
      { slug: registered, issuer: true },
    ]);
  });
  it("stores at most one issuer per Vendor", async () => {
    const issuer = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example retailer",
      website: "https://example.test",
    });
    await getDb(ctx.db).insert(externalSource).values({
      slug: "example-first",
      label: "First",
      vendorId: issuer.id,
      issuer: true,
    });
    await expect(
      getDb(ctx.db).insert(externalSource).values({
        slug: "example-second",
        label: "Second",
        vendorId: issuer.id,
        issuer: true,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        constraint: "ExternalSource_vendor_issuer_key",
      }),
    });
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
    const lookups = await lookupProductIdentifierSources(ctx.db, [
      { url: "https://example.test/p/1" },
      { url: "ftp://example.test/p/1" },
      { url: "https://other.test/p/2" },
    ]);
    expect(lookups[0]?.error).toContain(other.shortcode);
    expect(lookups[1]?.error).toContain("HTTP page host");
    expect(lookups[2]).toEqual({ source: null, error: null });
    expect(await getDb(ctx.db).select().from(externalSource)).toMatchObject([
      { vendorId: other.id },
    ]);
  });
  it("reports a Vendor's Product identifiers held outside its issuer", async () => {
    const issuer = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example drifting retailer",
      website: "https://example.test",
    });
    await getDb(ctx.db)
      .insert(externalSource)
      .values([
        { slug: "example-orders", label: "Orders", vendorId: issuer.id },
        { slug: "example-unowned", label: "Unowned legacy" },
        {
          slug: "example-catalog",
          label: "Catalog",
          vendorId: issuer.id,
          issuer: true,
        },
      ]);
    const owner = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic drifting product",
      manufacturer: "Synthetic maker",
    });
    await getDb(ctx.db)
      .insert(entityExternalId)
      .values(
        (
          [
            ["example-orders", "retailer_sku", "100200"],
            ["example-orders", "internet_number", "300400500"],
            ["example-unowned", "retailer_sku", "600700"],
            ["example-catalog", "retailer_sku", "800900"],
          ] as const
        ).map(([source, kind, externalId]) => ({
          entityKind: "product" as const,
          entityId: owner.id,
          source,
          kind,
          externalId,
          isPrimary: false,
        })),
      );
    expect(await findProductIdentifiersOutsideIssuer(ctx.db)).toEqual([
      {
        vendorId: issuer.shortcode,
        vendorName: "Example drifting retailer",
        source: "example-orders",
        issuer: "example-catalog",
        identifierCount: 2,
        kinds: ["internet_number", "retailer_sku"],
      },
    ]);
  });
});
