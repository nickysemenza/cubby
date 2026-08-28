import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ManifestCard } from "./manifest-card";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("ManifestCard", () => {
  it("keeps its Open action for hover cards but yields it to an inspector header", () => {
    const props = {
      entity: "vendor" as const,
      routeParam: "VEN-4K7M",
      icon: <span />,
      name: "Example vendor",
      tag: "vendor",
    };
    const { rerender } = render(<ManifestCard {...props} />, {
      wrapper: harness.wrapper,
    });

    expect(screen.getByLabelText("Open")).toHaveAttribute(
      "href",
      "/vendors/VEN-4K7M",
    );

    rerender(<ManifestCard {...props} showOpenAction={false} />);

    expect(screen.queryByLabelText("Open")).not.toBeInTheDocument();
  });
});
