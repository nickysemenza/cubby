import { describe, expect, it } from "vitest";
import { isSyntheticOrderId, purchaseOrderUrl } from "./vendor";

const AMAZON =
  "https://www.amazon.com/gp/your-account/order-details?orderID={orderId}";
const HOME_DEPOT =
  "https://www.homedepot.com/myaccount/order-details?orderNumber={orderId}";
const EBAY = "https://www.ebay.com/mesh/ord/details?orderid={orderId}";

describe("purchaseOrderUrl", () => {
  it("substitutes the order id for the three seeded vendors", () => {
    expect(
      purchaseOrderUrl({
        orderUrlTemplate: AMAZON,
        orderId: "111-4599076-5153040",
      }),
    ).toBe(
      "https://www.amazon.com/gp/your-account/order-details?orderID=111-4599076-5153040",
    );
    expect(
      purchaseOrderUrl({ orderUrlTemplate: HOME_DEPOT, orderId: "WN28187563" }),
    ).toBe(
      "https://www.homedepot.com/myaccount/order-details?orderNumber=WN28187563",
    );
    expect(
      purchaseOrderUrl({ orderUrlTemplate: EBAY, orderId: "14-14938-39125" }),
    ).toBe("https://www.ebay.com/mesh/ord/details?orderid=14-14938-39125");
  });

  it("returns null when either side is missing or blank", () => {
    expect(
      purchaseOrderUrl({ orderUrlTemplate: null, orderId: "WN28187563" }),
    ).toBeNull();
    expect(
      purchaseOrderUrl({ orderUrlTemplate: AMAZON, orderId: null }),
    ).toBeNull();
    expect(purchaseOrderUrl({})).toBeNull();
    expect(
      purchaseOrderUrl({ orderUrlTemplate: "   ", orderId: "WN28187563" }),
    ).toBeNull();
    expect(
      purchaseOrderUrl({ orderUrlTemplate: AMAZON, orderId: "  " }),
    ).toBeNull();
  });

  it("trims surrounding whitespace before substituting", () => {
    expect(
      purchaseOrderUrl({
        orderUrlTemplate: `  ${HOME_DEPOT}  `,
        orderId: "  WN28187563  ",
      }),
    ).toBe(
      "https://www.homedepot.com/myaccount/order-details?orderNumber=WN28187563",
    );
  });

  // The 27 in-store Home Depot rows. A template CAN substitute into these — the
  // point is that it must not: the resulting page is a dead end because the
  // in-store lookup also needs a receipt number, register number, and
  // transaction type Cubby never captured.
  it("refuses synthetic import keys", () => {
    expect(
      purchaseOrderUrl({
        orderUrlTemplate: HOME_DEPOT,
        orderId: "txn:2023-09-17/639/5201",
      }),
    ).toBeNull();
    expect(isSyntheticOrderId("txn:2023-09-17/639/5201")).toBe(true);
    expect(isSyntheticOrderId("WN28187563")).toBe(false);
  });

  // A half-typed template would otherwise link every purchase to one page.
  it("refuses a template with no {orderId} token", () => {
    expect(
      purchaseOrderUrl({
        orderUrlTemplate: "https://www.homedepot.com/myaccount/order-details",
        orderId: "WN28187563",
      }),
    ).toBeNull();
  });

  it("percent-encodes ids that carry URL-significant characters", () => {
    // Tool Nirvana prints a leading '#', which would otherwise truncate the URL
    // at the fragment.
    expect(
      purchaseOrderUrl({ orderUrlTemplate: EBAY, orderId: "#11325" }),
    ).toBe("https://www.ebay.com/mesh/ord/details?orderid=%2311325");
    // An invoice-numbered vendor's slash would otherwise become a path segment.
    expect(
      purchaseOrderUrl({ orderUrlTemplate: EBAY, orderId: "C02791/2" }),
    ).toBe("https://www.ebay.com/mesh/ord/details?orderid=C02791%2F2");
  });

  it("substitutes every occurrence of the token", () => {
    expect(
      purchaseOrderUrl({
        orderUrlTemplate: "https://x.test/{orderId}?ref={orderId}",
        orderId: "AB12",
      }),
    ).toBe("https://x.test/AB12?ref=AB12");
  });
});
