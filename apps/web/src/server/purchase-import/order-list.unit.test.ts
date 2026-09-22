import type { BrowserCapture } from "@cubby/schemas/purchase-import";
import { describe, expect, it } from "vitest";

import { classifyOrderCapture } from "./order-list";

const ALLOWED_HOSTS = ["shop.example.test"];

function capture(overrides: Partial<BrowserCapture>): BrowserCapture {
  return {
    url: "https://shop.example.test/",
    title: "",
    text: "",
    links: [],
    images: [],
    capturedAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("classifyOrderCapture", () => {
  it("classifies an Amazon-style history page with dated orders and a next link", () => {
    const cap = capture({
      url: "https://shop.example.test/order-history?startIndex=0",
      title: "Your Orders",
      text: [
        "Order placed September 15, 2026",
        "Order # 111-2222222-3333333",
        "",
        "Order placed 2026-08-01",
        "Order # 222-3333333-4444444",
        "",
        "Order placed 1 Jul 2026",
        "Order # 333-4444444-5555555",
      ].join("\n"),
      links: [
        {
          id: "l1",
          href: "https://shop.example.test/order-details?orderID=111-2222222-3333333",
          text: "View order details",
        },
        {
          id: "l2",
          href: "https://shop.example.test/order-details?orderID=222-3333333-4444444",
          text: "View order details",
        },
        {
          id: "l3",
          href: "https://shop.example.test/order-details?orderID=333-4444444-5555555",
          text: "View order details",
        },
        {
          id: "l4",
          href: "https://shop.example.test/order-history?startIndex=10",
          text: "Next",
        },
      ],
    });

    const result = classifyOrderCapture(cap, { allowedHosts: ALLOWED_HOSTS });
    expect(result.kind).toBe("order_list");
    if (result.kind !== "order_list") return;

    expect(result.orders).toHaveLength(3);
    const byId = new Map(result.orders.map((o) => [o.orderId, o]));
    expect(byId.get("111-2222222-3333333")).toMatchObject({
      orderUrl:
        "https://shop.example.test/order-details?orderID=111-2222222-3333333",
      orderedAt: "2026-09-15",
    });
    expect(byId.get("222-3333333-4444444")).toMatchObject({
      orderedAt: "2026-08-01",
    });
    expect(byId.get("333-4444444-5555555")).toMatchObject({
      orderedAt: "2026-07-01",
    });
    expect(result.nextPageUrl).toBe(
      "https://shop.example.test/order-history?startIndex=10",
    );
  });

  it("classifies a single order-details page as an order", () => {
    const cap = capture({
      url: "https://shop.example.test/order-details?orderID=111-2222222-3333333",
      title: "Order Details",
      text: "Order # 111-2222222-3333333 placed September 15, 2026",
    });

    expect(classifyOrderCapture(cap, { allowedHosts: ALLOWED_HOSTS })).toEqual({
      kind: "order",
    });
  });

  it("classifies a product page with no order ids as unknown", () => {
    const cap = capture({
      url: "https://shop.example.test/dp/B0EXAMPLE1",
      title: "Wireless Widget",
      text: "Price: $19.99. Add to cart.",
    });

    expect(classifyOrderCapture(cap, { allowedHosts: ALLOWED_HOSTS })).toEqual({
      kind: "unknown",
    });
  });

  it("leaves orderUrl null when the only link for an id is on a disallowed host", () => {
    const cap = capture({
      url: "https://shop.example.test/order-history",
      title: "Your Orders",
      text: ["Order # 111-2222222-3333333", "Order # 222-3333333-4444444"].join(
        "\n",
      ),
      links: [
        {
          id: "l1",
          href: "https://evil.example.test/order-details?orderID=111-2222222-3333333",
          text: "View order details",
        },
      ],
    });

    const result = classifyOrderCapture(cap, { allowedHosts: ALLOWED_HOSTS });
    expect(result.kind).toBe("order_list");
    if (result.kind !== "order_list") return;
    const target = result.orders.find(
      (o) => o.orderId === "111-2222222-3333333",
    );
    expect(target?.orderUrl).toBeNull();
  });

  it("captures a labelled generic order id but not a bare ASIN-like token", () => {
    const cap = capture({
      url: "https://shop.example.test/order-history",
      title: "Order history",
      text: [
        "Order #ABC123XYZ",
        "Order # 999-8888888-7777777",
        "Item ASIN: B0TESTTOKEN",
      ].join("\n"),
    });

    const result = classifyOrderCapture(cap, { allowedHosts: ALLOWED_HOSTS });
    expect(result.kind).toBe("order_list");
    if (result.kind !== "order_list") return;
    const ids = result.orders.map((o) => o.orderId);
    expect(ids).toContain("ABC123XYZ");
    expect(ids).toContain("999-8888888-7777777");
    expect(ids).not.toContain("B0TESTTOKEN");
  });
});
