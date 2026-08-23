// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OrderIdLink } from "./OrderIdLink";

/**
 * The component's whole job is the null branch: `orderUrl` is already derived
 * server-side by `purchaseOrderUrl`, so a missing one means the order genuinely
 * isn't linkable — no template, no order id, a synthetic `txn:` key, or a
 * template that isn't absolute http(s). Rendering an anchor anyway would put a
 * dead link on 27 in-store Home Depot rows, which is worse than plain text.
 */
describe("OrderIdLink", () => {
  it("renders nothing when the order isn't linkable", () => {
    const { container: noUrl } = render(
      <OrderIdLink orderUrl={null} orderId="txn:2023-09-17/639/5201" />,
    );
    expect(noUrl).toBeEmptyDOMElement();

    // `undefined` reaches this from the optional `orderUrl` on the preview-card
    // view models, and must behave the same as an explicit null.
    const { container: undef } = render(
      <OrderIdLink orderUrl={undefined} orderId="WN28187563" />,
    );
    expect(undef).toBeEmptyDOMElement();
  });

  it("opens the vendor's order page in a new tab, named for the order", () => {
    render(
      <OrderIdLink
        orderUrl="https://www.homedepot.com/myaccount/order-details?orderNumber=WN28187563"
        orderId="WN28187563"
        vendorName="Home Depot"
      />,
    );

    const link = screen.getByRole("link", {
      name: "Open order WN28187563 at Home Depot",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://www.homedepot.com/myaccount/order-details?orderNumber=WN28187563",
    );
    expect(link).toHaveAttribute("target", "_blank");
    // Without noopener the opened tab can reach back through window.opener.
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("still names the link when the vendor was soft-deleted", () => {
    render(
      <OrderIdLink
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
