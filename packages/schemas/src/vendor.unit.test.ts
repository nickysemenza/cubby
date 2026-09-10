import { describe, expect, it } from "vitest";
import {
  isSyntheticOrderId,
  purchaseOrderUrl,
  vendorFiltersSchema,
} from "./vendor";

it("keeps purchase-count filters nonnegative while allowing signed spend", () => {
  expect(vendorFiltersSchema.safeParse({ purchaseCountMin: -1 }).success).toBe(
    false,
  );
  expect(vendorFiltersSchema.safeParse({ purchaseCountMax: 1.5 }).success).toBe(
    false,
  );
  expect(
    vendorFiltersSchema.parse({ purchaseCountMin: 0, spendMin: -50 }),
  ).toMatchObject({
    purchaseCountMin: 0,
    spendMin: -50,
  });
});

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

  it("refuses a template with no {orderId} token", () => {
    expect(
      purchaseOrderUrl({
        orderUrlTemplate: "https://www.homedepot.com/myaccount/order-details",
        orderId: "WN28187563",
      }),
    ).toBeNull();
  });

  it("percent-encodes ids that carry URL-significant characters", () => {
    expect(
      purchaseOrderUrl({ orderUrlTemplate: EBAY, orderId: "#11325" }),
    ).toBe("https://www.ebay.com/mesh/ord/details?orderid=%2311325");
    expect(
      purchaseOrderUrl({ orderUrlTemplate: EBAY, orderId: "C02791/2" }),
    ).toBe("https://www.ebay.com/mesh/ord/details?orderid=C02791%2F2");
  });

  // `orderUrlTemplate` is unvalidated free text but `orderUrl` is `z.url()`
  // inside `strictOutput`. A scheme-less paste — the natural thing to copy out
  // of a browser — would otherwise produce a string zod rejects, throwing
  // during output validation and 500-ing every read containing that vendor
  // rather than just dropping the link.
  it("refuses a template that isn't an absolute URL", () => {
    for (const template of [
      "homedepot.com/myaccount/order-details?orderNumber={orderId}",
      "www.amazon.com/gp/your-account/order-details?orderID={orderId}",
      "/orders/{orderId}",
      "{orderId}",
    ]) {
      expect(
        purchaseOrderUrl({ orderUrlTemplate: template, orderId: "AB12" }),
      ).toBeNull();
    }
  });

  it("refuses non-http(s) schemes", () => {
    for (const template of [
      "javascript:alert('{orderId}')",
      "data:text/html,{orderId}",
      "file:///etc/{orderId}",
      "mailto:orders@x.test?subject={orderId}",
    ]) {
      expect(
        purchaseOrderUrl({ orderUrlTemplate: template, orderId: "AB12" }),
      ).toBeNull();
    }
  });

  it("allows plain http as well as https", () => {
    expect(
      purchaseOrderUrl({
        orderUrlTemplate: "http://intranet.test/orders/{orderId}",
        orderId: "AB12",
      }),
    ).toBe("http://intranet.test/orders/AB12");
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
