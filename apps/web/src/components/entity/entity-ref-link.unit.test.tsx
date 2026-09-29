import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EntityDisplayImagesProvider,
  entityDisplayImageKey,
} from "~/app/_components/entity-media/entity-display-images";
import { BasicInfo } from "~/components/common/basic-info";
import { isBrowserRoutedEntity } from "~/entities/entities";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { EntityRefLink } from "./entity-ref-link";

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

describe("EntityRefLink inline variant", () => {
  const product = { id: "PRD-TEST", name: "Test product" };

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
        showIdentityMark={false}
      />,
    );

    const link = screen.getByRole("link", { name: "Test product" });
    expect(link.querySelector("img")).toBeNull();
    expect(link.querySelector("svg")).toBeNull();
  });

  // An explicit `null` means "intentionally render the mark". Falling back to
  // the surrounding provider's image (as the chip variant does for an omitted
  // prop) would make every explicit-null call site start showing covers.
  it("keeps an explicit null image even inside a display-image provider", () => {
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
    ).toBeNull();
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

describe("EntityRefLink chip variant", () => {
  it("falls back to the provider's canonical image when none is passed", () => {
    renderLink(
      <EntityDisplayImagesProvider
        refs={[]}
        seeded={seededProductImage("PRD-CHIP")}
      >
        <EntityRefLink
          variant="chip"
          entity="product"
          id="PRD-CHIP"
          name="Chip product"
        />
      </EntityDisplayImagesProvider>,
    );

    expect(
      screen.getByRole("link", { name: /Chip product/ }).querySelector("img"),
    ).toHaveAttribute("src", "https://images.example/seeded.jpg");
  });

  it("labels an unnamed record by its id", () => {
    renderLink(
      <EntityRefLink
        variant="chip"
        entity="project"
        id="PRJ-TEST"
        name={null}
      />,
    );

    expect(screen.getByRole("link", { name: /PRJ-TEST/ })).toHaveAttribute(
      "href",
      "/projects/PRJ-TEST",
    );
  });
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
      manufacturer: "Fairlife",
      fdc_id: 2670155,
    };
    renderLink(
      <EntityRefLink variant="list" entity="product" items={[linkedProduct]} />,
    );

    expect(
      screen.getByRole("link", { name: /Fairlife 2% milk/ }),
    ).toHaveAttribute("href", "/products/PRD-TEST");
  });

  it("still renders declared USDA foods through the usda-food branch", () => {
    renderLink(
      <EntityRefLink
        variant="list"
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
      manufacturer: "Cubby",
    };
    renderLink(
      <EntityDisplayImagesProvider
        refs={[]}
        seeded={seededProductImage(product.id)}
      >
        <EntityRefLink
          variant="list"
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
    renderLink(<EntityRefLink variant="list" entity="recipe" items={[]} />);

    expect(screen.getByText("No items linked yet")).toBeInTheDocument();
  });
});

describe("EntityRefLink by-id variant", () => {
  it("links a supplied name without fetching the record", () => {
    renderLink(
      <EntityRefLink
        variant="byId"
        entityKind="project"
        entityId="PRJ-TEST"
        name="Deck rebuild"
      />,
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
        variant="byId"
        entityKind="inventory"
        entityId="00000000-0000-0000-0000-000000000000"
      />,
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Inventory Entry")).toBeInTheDocument();
  });

  it("sends a cookbook to the cookbook index", () => {
    renderLink(
      <EntityRefLink
        variant="byId"
        entityKind="cookbook"
        entityId="CKB-TEST"
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
      <EntityRefLink
        variant="audit"
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
      <EntityRefLink
        variant="audit"
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
    // SAFETY: the audit union is a compile-time subset; the runtime row may
    // still carry a kind without a route, which is what is exercised here.
    const unrouted = "imageSighting" as never;
    expect(isBrowserRoutedEntity(unrouted)).toBe(false);

    renderLink(
      <EntityRefLink
        variant="audit"
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

describe("EntityRefLink preview variant", () => {
  it("links the record around arbitrary children", () => {
    renderLink(
      <EntityRefLink
        variant="preview"
        entity="ingredient"
        id="ING-TEST"
        displayImage={null}
        showIdentityMark={false}
      >
        flour
      </EntityRefLink>,
    );

    expect(screen.getByRole("link", { name: "flour" })).toHaveAttribute(
      "href",
      "/ingredients/ING-TEST",
    );
  });

  it("routes usda-food by its fdc id", () => {
    renderLink(
      <EntityRefLink
        variant="preview"
        entity="usda-food"
        id="171265"
        displayImage={null}
      >
        Milk
      </EntityRefLink>,
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
              <EntityRefLink
                variant="table"
                to="/usda/upc/$code"
                params={{ code: "012345678905" }}
                tone="mono"
              >
                012345678905
              </EntityRefLink>
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
      <EntityRefLink
        variant="filter"
        display="value"
        to="/products"
        search={{ manufacturer: "Acme" }}
        label="Show all products by Acme"
      >
        Acme
      </EntityRefLink>,
    );

    const link = screen.getByRole("link", {
      name: "Show all products by Acme",
    });
    expect(link).toHaveAttribute("href", "/products?manufacturer=Acme");
    link.focus();
    expect(link).toHaveFocus();
  });

  it("keeps the filter action outside an editable value", () => {
    renderLink(
      <BasicInfo
        fields={[
          {
            label: "Category",
            value: <button type="button">Edit category</button>,
            filterAction: (
              <EntityRefLink
                variant="filter"
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
      <EntityRefLink
        variant="order"
        orderUrl={null}
        orderId="txn:2023-09-17/639/5201"
      />,
    );
    expect(noUrl).toBeEmptyDOMElement();

    // `undefined` reaches this from the optional `orderUrl` on the preview-card
    // view models, and must behave the same as an explicit null.
    const { container: undef } = renderLink(
      <EntityRefLink variant="order" orderUrl={undefined} orderId="AB12" />,
    );
    expect(undef).toBeEmptyDOMElement();
  });

  it("opens the vendor's order page in a new tab, named for the order", () => {
    renderLink(
      <EntityRefLink
        variant="order"
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
      <EntityRefLink
        variant="order"
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
