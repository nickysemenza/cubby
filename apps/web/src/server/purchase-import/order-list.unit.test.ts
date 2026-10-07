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
  it("does not borrow the date of a longer numeric order or turn promotional counts into orders", () => {
    expect(
      classifyOrderCapture(
        capture({
          url: "https://shop.example.test/account",
          title: "Account",
          text: "View all your orders\n#54321 September 12, 2026\n#5432 September 14, 2026",
          links: [
            {
              id: "short",
              href: "https://shop.example.test/account/orders/opaque",
              text: "#5432",
            },
          ],
        }),
        { allowedHosts: ALLOWED_HOSTS },
      ),
    ).toMatchObject({
      kind: "order_list",
      orders: [{ orderId: "5432", orderedAt: "2026-09-14" }],
    });
    expect(
      classifyOrderCapture(
        capture({
          url: "https://shop.example.test/account/orders/opaque",
          title: "Order #54321",
          text: "Order #54321 September 12, 2026. Order 2 or more items for free shipping.",
        }),
        { allowedHosts: ALLOWED_HOSTS },
      ),
    ).toEqual({ kind: "order" });
  });

  it("uses short linked order labels and the following date in an account row", () => {
    const result = classifyOrderCapture(
      capture({
        url: "https://shop.example.test/account",
        title: "Account",
        text: "View all your orders\nOrder Date Total\n#54321 September 12, 2026 $12.00\n#54322 September 14, 2026 $18.00",
        links: [
          {
            id: "one",
            href: "https://shop.example.test/account/orders/opaque-one",
            text: "#54321",
          },
          {
            id: "two",
            href: "https://shop.example.test/account/orders/opaque-two",
            text: "#54322",
          },
          {
            id: "foreign",
            href: "https://other.example.test/account/orders/opaque-three",
            text: "#54323",
          },
        ],
      }),
      { allowedHosts: ALLOWED_HOSTS },
    );
    expect(result).toEqual({
      kind: "order_list",
      nextPageUrl: null,
      orders: [
        {
          orderId: "54321",
          orderUrl: "https://shop.example.test/account/orders/opaque-one",
          orderedAt: "2026-09-12",
        },
        {
          orderId: "54322",
          orderUrl: "https://shop.example.test/account/orders/opaque-two",
          orderedAt: "2026-09-14",
        },
      ],
    });
    expect(
      classifyOrderCapture(
        capture({
          url: "https://shop.example.test/account/orders/opaque-one",
          title: "Order #54321",
          text: "Order #54321 September 12, 2026 Total $12.00",
        }),
        { allowedHosts: ALLOWED_HOSTS },
      ),
    ).toEqual({ kind: "order" });
  });

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

  it("keeps every order link when IDs are embedded in URL paths", () => {
    const ids = [
      "111-2222222-3333333",
      "222-3333333-4444444",
      "333-4444444-5555555",
    ];
    const cap = capture({
      url: "https://shop.example.test/order-history",
      title: "Your Orders",
      text: ids.map((id) => `Order # ${id}`).join("\n"),
      links: ids.map((id, index) => ({
        id: `link-${index}`,
        href: `https://shop.example.test/${id}`,
        text: "View order details",
      })),
    });

    const result = classifyOrderCapture(cap, { allowedHosts: ALLOWED_HOSTS });
    expect(result.kind).toBe("order_list");
    if (result.kind !== "order_list") return;
    expect(result.orders.map(({ orderUrl }) => orderUrl)).toEqual(
      ids.map((id) => `https://shop.example.test/${id}`),
    );
  });
});
