import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children?: ReactNode;
    to: string;
    params?: { id?: string; shortcode?: string };
    [key: string]: unknown;
  }) => (
    <a {...props} href={to.replace("$shortcode", params?.shortcode ?? "")}>
      {children}
    </a>
  ),
}));

import { ManifestCard } from "./manifest-card";

describe("ManifestCard", () => {
  it("keeps its Open action for hover cards but yields it to an inspector header", () => {
    const props = {
      entity: "vendor" as const,
      routeParam: "VEN-4K7M",
      icon: <span />,
      name: "Example vendor",
      tag: "vendor",
    };
    const { rerender } = render(<ManifestCard {...props} />);

    expect(screen.getByLabelText("Open")).toHaveAttribute(
      "href",
      "/vendors/VEN-4K7M",
    );

    rerender(<ManifestCard {...props} showOpenAction={false} />);

    expect(screen.queryByLabelText("Open")).not.toBeInTheDocument();
  });
});
