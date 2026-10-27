import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isBrowserRoutedEntity } from "~/entity/entities";
import {
  EntityDisplayImagesProvider,
  entityDisplayImageKey,
} from "~/entity/entity-media/entity-display-images";
import { entityPreviewQueryOptions } from "~/entity/entity-query";
import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { Facts } from "~/ui/common/facts";
import { DenseCellContext } from "~/ui/common/stacked-value";

import {
  EntityRefLink,
  EntityRefList,
  EntityAuditLink,
  EntityRouteLink,
  EntityFilterLink,
  VendorOrderLink,
} from "./entity-ref-link";
import { PreviewRefLink as EntityPreviewLink } from "./ref-link/leaf";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  cleanup();
  harness.dispose();
});

const renderLink = (ui: React.ReactNode) =>
  render(ui, { wrapper: harness.wrapper });

const seededProductImage = (id: string) =>
  ({
    [entityDisplayImageKey({ entityKind: "product", entityId: id })]: {
      url: "https://images.example/seeded.jpg",
    },
  }) as const;

describe("EntityRefLink with entity data", () => {
  const product = { id: "PRD-TEST", name: "Test product" };

  it("keeps identity links to one name even when stacked context is requested", () => {
    renderLink(
      <DenseCellContext value={{ linksTo: null, identity: true }}>
        <EntityRefLink
          entity="product"
          data={{ ...product, brandName: "Synthetic brandName" }}
          displayImage={null}

          context="Synthetic context"
        />
      </DenseCellContext>,
    );
    expect(screen.getByRole("link", { name: "Test product" })).toBeVisible();
    expect(
      screen.queryByText(/Synthetic brandName|Synthetic context/),
    ).not.toBeInTheDocument();
  });

  it("renders the explicitly supplied canonical image", () => {
    renderLink(
      <EntityRefLink
        entity="product"
        data={product}
        displayImage={{ url: "https://example.com/product.jpg" }}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Test product" }).querySelector("img"),
    ).toHaveAttribute("src", "https://example.com/product.jpg");
  });

  it("suppresses its identity mark when adjacent media already supplies it", () => {
    renderLink(
      <EntityRefLink
        entity="product"
        data={product}
        displayImage={{ url: "https://example.com/product.jpg" }}
        bare
      />,
    );

    const link = screen.getByRole("link", { name: "Test product" });
    expect(link.querySelector("img")).toBeNull();
    expect(link.querySelector("svg")).toBeNull();
  });

  // Placeholder nulls must not suppress a canonical transitive cover.
  it("fills an explicit null placeholder from the canonical display-image provider", () => {
    renderLink(
      <EntityDisplayImagesProvider
        refs={[]}
        seeded={seededProductImage(product.id)}
      >
        <EntityRefLink entity="product" data={product} displayImage={null} />
      </EntityDisplayImagesProvider>,
    );

    expect(
      screen.getByRole("link", { name: "Test product" }).querySelector("img"),
    ).toHaveAttribute("src", "https://images.example/seeded.jpg");
  });

  it.each([
    [
      "financialAccount",
      "/financial-accounts/FAC-TEST",
      <EntityRefLink
        key="a"
        entity="financialAccount"
        data={{ id: "FAC-TEST", name: "Checking" }}
        displayImage={null}
      />,
    ],
    [
      "financialTransaction",
      "/financial-transactions/FTX-TEST",
      <EntityRefLink
        key="b"
        entity="financialTransaction"
        data={{ id: "FTX-TEST", displayName: "Market purchase" }}
        displayImage={null}
      />,
    ],
    [
      "wish",
      "/wishes/WSH-TEST",
      <EntityRefLink
        key="c"
        entity="wish"
        data={{ id: "WSH-TEST", name: "Garden bench" }}
        displayImage={null}
      />,
    ],
    [
      "image",
      "/images/IMG-TEST",
      <EntityRefLink
        key="d"
        entity="image"
        data={{ id: "IMG-TEST", filename: "bench.jpg" }}
        displayImage={null}
      />,
    ],
  ])("links %s with its declared title field", (_entity, href, ui) => {
    renderLink(ui);

    expect(screen.getByRole("link")).toHaveAttribute("href", href);
  });

  it("derives a purchase's text from its label, not an invented name", () => {
    renderLink(
      <EntityRefLink
        entity="purchase"
        data={{
          id: "PUR-TEST",
          orderId: "ORD-1",
          vendorName: "Acme",
          date: "2026-01-05",
        }}
        displayImage={null}
      />,
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/purchases/PUR-TEST");
    expect(link).toHaveTextContent("ORD-1");
    expect(link).toHaveTextContent("Acme");
  });
});

describe("EntityRefLink record identity", () => {
  it("resolves a fetched Product whose cover exists only inside its envelope", async () => {
    const id = "PRD-4K7M";
    const queryKey = entityPreviewQueryOptions("product", id).queryKey;
    harness.queryClient.setQueryDefaults(queryKey, { enabled: false });
    renderLink(<EntityRefLink entity="product" id={id} name={null} />);
    await act(async () => {
      harness.queryClient.setQueryData(queryKey, {
        id,
        name: "Synthetic enveloped product",
        fields: {
          displayImages: fieldValueFixture(
            entityFieldEnvelopeSchemas.product.detail.shape.fields.shape
              .displayImages,
            [{ id: "IMG-4K7M", url: "https://images.example/enveloped.jpg" }],
          ),
        },
      });
    });
    expect(
      await screen.findByRole("link", { name: "Synthetic enveloped product" }),
    ).toHaveAttribute("href", `/products/${id}`);
    expect(screen.getByRole("presentation")).toHaveAttribute(
      "src",
      expect.stringContaining("enveloped.jpg"),
    );
  });

  it("uses the same canonical image for audit pills even with a null placeholder", () => {
    renderLink(
      <EntityDisplayImagesProvider
        refs={[]}
        seeded={seededProductImage("PRD-AUDIT")}
      >
        <EntityAuditLink
          entityKind="product"
          entityId="PRD-AUDIT"
          name="Synthetic audit product"
          displayImage={null}
          layout="row"
        />
      </EntityDisplayImagesProvider>,
    );
    expect(
      screen
        .getByRole("link", { name: /Synthetic audit product/ })
        .querySelector("img"),
    ).toHaveAttribute("src", "https://images.example/seeded.jpg");
  });

  it("falls back to the provider's canonical image when none is passed", () => {
    renderLink(
      <EntityDisplayImagesProvider
        refs={[]}
        seeded={seededProductImage("PRD-CHIP")}
      >
        <EntityRefLink entity="product" id="PRD-CHIP" name="Chip product" />
      </EntityDisplayImagesProvider>,
    );

    expect(
      screen.getByRole("link", { name: /Chip product/ }).querySelector("img"),
    ).toHaveAttribute("src", "https://images.example/seeded.jpg");
  });

  // A missing projection name must resolve without losing the record route,
  // including kinds whose legacy audit references used UUIDs.
  it.each([
    ["project", "PRJ-4K7M", "/projects/PRJ-4K7M"],
    ["inventory", "INV-4K7M", "/inventory/INV-4K7M"],
    ["cookbook", "CKB-4K7M", "/cookbooks/CKB-4K7M"],
  ] as const)(
    "resolves an unnamed %s chip and preserves its destination",
    async (entity, id, href) => {
      const queryKey = entityPreviewQueryOptions(entity, id).queryKey;
      harness.queryClient.setQueryDefaults(queryKey, { enabled: false });
      renderLink(<EntityRefLink entity={entity} id={id} name={null} />);
      expect(screen.getByRole("status")).toHaveTextContent("Loading");
      expect(screen.queryByRole("link")).toBeNull();
      await act(async () => {
        harness.queryClient.setQueryData(queryKey, {
          id,
          [entitySummary[entity].titleField]: "Synthetic resolved record",
        });
      });
      expect(
        await screen.findByRole("link", { name: /Synthetic resolved record/ }),
      ).toHaveAttribute("href", href);
    },
  );
});

describe("EntityRefLink list variant", () => {
  // Regression: a USDA-linked product row carries an `fdc_id` key. Dispatching
  // on shape ("fdc_id" in item) instead of the declared entity sent every
  // linked product on a USDA food page through the usda-food branch, which
  // reads `foodInfo` and crashed the page.
  it("renders a USDA-linked product as a product, not as a USDA food", () => {
    // Not an object literal at the call site: the `fdc_id` key is the whole
    // point, and an excess-property check would otherwise pick the wrong
    // union member.
    const linkedProduct = {
      id: "PRD-TEST",
      name: "Fairlife 2% milk",
      brandName: "Fairlife",
      fdc_id: 2670155,
    };
    renderLink(<EntityRefList entity="product" items={[linkedProduct]} />);

    expect(
      screen.getByRole("link", { name: /Fairlife 2% milk/ }),
    ).toHaveAttribute("href", "/products/PRD-TEST");
  });

  it("still renders declared USDA foods through the usda-food branch", () => {
    renderLink(
      <EntityRefList
        entity="usda-food"
        items={[{ fdc_id: 171265, foodInfo: { description: "Milk, whole" } }]}
      />,
    );

    expect(screen.getByRole("link", { name: "Milk, whole" })).toHaveAttribute(
      "href",
      "/usda/171265",
    );
  });

  it("uses a collection owner's canonical image without issuing a cell request", () => {
    const product = {
      id: "PRD-TABLE",
      name: "Table-owned image",
      brandName: "Cubby",
    };
    renderLink(
      <EntityDisplayImagesProvider
        refs={[]}
        seeded={seededProductImage(product.id)}
      >
        <EntityRefList
          entity="product"
          items={[product]}
          resolveImages={false}
        />
      </EntityDisplayImagesProvider>,
    );

    expect(
      screen
        .getByRole("link", { name: /Table-owned image/ })
        .querySelector("img"),
    ).toHaveAttribute("src", "https://images.example/seeded.jpg");
  });

  it("renders the empty placeholder for no items", () => {
    renderLink(<EntityRefList entity="recipe" items={[]} />);

    expect(screen.getByText("No items linked yet.")).toBeInTheDocument();
  });
});

describe("EntityRefLink by-id variant", () => {
  it("links a supplied name without fetching the record", () => {
    renderLink(
      <EntityRefLink entity="project" id="PRJ-TEST" name="Deck rebuild" />,
    );

    expect(screen.getByRole("link", { name: /Deck rebuild/ })).toHaveAttribute(
      "href",
      "/projects/PRJ-TEST",
    );
  });

  // The id handed to this variant for an inventory entry is a uuid, not the
  // shortcode a URL needs, so it must not build a link at all.
  it("renders an inventory entry unlinked", () => {
    renderLink(
      <EntityRefLink
        entity="inventory"
        id="00000000-0000-0000-0000-000000000000"
      />,
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Inventory Entry")).toBeInTheDocument();
  });

  it("sends a cookbook to the cookbook index", () => {
    renderLink(
      <EntityRefLink
        entity="cookbook"
        id="00000000-0000-0000-0000-000000000000"
      />,
    );

    expect(screen.getByRole("link", { name: "Cookbook" })).toHaveAttribute(
      "href",
      "/cookbooks",
    );
  });
});

describe("EntityRefLink audit variant", () => {
  it("leads with the name and trails the code as a stamp", () => {
    renderLink(
      <EntityAuditLink
        entityKind="project"
        entityId="PRJ-TEST"
        name="Deck rebuild"
        displayImage={null}
      />,
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/projects/PRJ-TEST");
    expect(link).toHaveAttribute("title", "Deck rebuild · PRJ-TEST");
    expect(link).toHaveClass("min-h-11", "sm:min-h-0");
  });

  it("falls back to type plus code when no name resolved", () => {
    renderLink(
      <EntityAuditLink
        entityKind="project"
        entityId="PRJ-TEST"
        displayImage={null}
      />,
    );

    expect(screen.getByRole("link")).toHaveTextContent("PRJ-TEST");
  });

  it("does not link an entity without a browser route", () => {
    // A legacy audit row can carry a kind that is no longer an entity; it has
    // no route, so it must not become a dead link.
    const unrouted = "imageSighting" as never;
    expect(isBrowserRoutedEntity(unrouted)).toBe(false);

    renderLink(
      <EntityAuditLink
        entityKind={unrouted}
        entityId="IMS-TEST"
        name="Old sighting"
        displayImage={null}
      />,
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByTitle("Old sighting · IMS-TEST")).toBeInTheDocument();
  });
});

describe("Record preview trigger", () => {
  it("links the record around arbitrary children", () => {
    renderLink(
      <EntityPreviewLink
        entity="ingredient"
        id="ING-TEST"
        displayImage={null}
        showIdentityMark={false}
      >
        flour
      </EntityPreviewLink>,
    );

    expect(screen.getByRole("link", { name: "flour" })).toHaveAttribute(
      "href",
      "/ingredients/ING-TEST",
    );
  });

  it("routes usda-food by its fdc id", () => {
    renderLink(
      <EntityPreviewLink entity="usda-food" id="171265" displayImage={null}>
        Milk
      </EntityPreviewLink>,
    );

    expect(screen.getByRole("link", { name: /Milk/ })).toHaveAttribute(
      "href",
      "/usda/171265",
    );
  });
});

describe("EntityRefLink table variant", () => {
  // Table rows are clickable; the name link must win the click instead of also
  // navigating to the row's own destination.
  it("stops the click from reaching a clickable row", () => {
    const onRowClick = vi.fn();
    renderLink(
      <table>
        <tbody>
          <tr onClick={onRowClick}>
            <td>
              <EntityRouteLink
                to="/usda/upc/$code"
                params={{ code: "012345678905" }}
                tone="mono"
              >
                012345678905
              </EntityRouteLink>
            </td>
          </tr>
        </tbody>
      </table>,
    );

    const link = screen.getByRole("link", { name: "012345678905" });
    expect(link).toHaveAttribute("href", "/usda/upc/012345678905");
    fireEvent.click(link);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe("EntityRefLink filter variant", () => {
  it("turns a read-only facet into a readable filtered-list link", () => {
    renderLink(
      <EntityFilterLink
        display="value"
        to="/products"
        search={{ brandName: "Acme" }}
        label="Show all products by Acme"
      >
        Acme
      </EntityFilterLink>,
    );

    const link = screen.getByRole("link", {
      name: "Show all products by Acme",
    });
    expect(link).toHaveAttribute("href", "/products?brandName=Acme");
    link.focus();
    expect(link).toHaveFocus();
  });

  it("keeps the filter action outside an editable value", () => {
    renderLink(
      <Facts
        layout="list"
        facts={[
          {
            label: "Category",
            value: <button type="button">Edit category</button>,
            filterAction: (
              <EntityFilterLink
                to="/products"
                search={{ category: "CAT-2224" }}
                label="Show all products in Tools"
              />
            ),
          },
        ]}
      />,
    );

    const edit = screen.getByRole("button", { name: "Edit category" });
    const filter = screen.getByRole("link", {
      name: "Show all products in Tools",
    });
    expect(edit.contains(filter)).toBe(false);
    expect(filter).toHaveClass("size-10", "sm:size-7");
  });
});

/**
 * The order variant's whole job is the null branch: `orderUrl` is already
 * derived server-side by `purchaseOrderUrl`, so a missing one means the order
 * genuinely isn't linkable — no template, no order id, a synthetic `txn:` key,
 * or a template that isn't absolute http(s). Rendering an anchor anyway would
 * put a dead link on in-store rows, which is worse than plain text.
 */
describe("EntityRefLink order variant", () => {
  it("renders nothing when the order isn't linkable", () => {
    const { container: noUrl } = renderLink(
      <VendorOrderLink orderUrl={null} orderId="txn:2023-09-17/639/5201" />,
    );
    expect(noUrl).toBeEmptyDOMElement();

    // `undefined` reaches this from the optional `orderUrl` on the preview-card
    // view models, and must behave the same as an explicit null.
    const { container: undef } = renderLink(
      <VendorOrderLink orderUrl={undefined} orderId="AB12" />,
    );
    expect(undef).toBeEmptyDOMElement();
  });

  it("opens the vendor's order page in a new tab, named for the order", () => {
    renderLink(
      <VendorOrderLink
        orderUrl="https://shop.example/orders?orderNumber=AB12"
        orderId="AB12"
        vendorName="Acme Supply"
      />,
    );

    const link = screen.getByRole("link", {
      name: "Open order AB12 at Acme Supply",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://shop.example/orders?orderNumber=AB12",
    );
    expect(link).toHaveAttribute("target", "_blank");
    // Without noopener the opened tab can reach back through window.opener.
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("still names the link when the vendor was soft-deleted", () => {
    renderLink(
      <VendorOrderLink
        orderUrl="https://x.test/AB12"
        orderId="AB12"
        vendorName={null}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Open order AB12 at the vendor" }),
    ).toBeInTheDocument();
  });
});
