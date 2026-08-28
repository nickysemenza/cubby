import type { ImageAssociation } from "@cubby/schemas/image";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ImageAssociationLinks } from "./image-associations";

const associations: ImageAssociation[] = [
  {
    entityType: "vendor",
    entityId: "VEN-ABCD",
    entityName: "Home Depot",
    role: "logo",
  },
  {
    entityType: "cookbook",
    entityId: "CKB-EFGH",
    entityName: "The Food Lab",
    role: "cover",
  },
];

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("ImageAssociationLinks", () => {
  it("links every direct association and identifies each relationship role", () => {
    render(<ImageAssociationLinks associations={associations} showRole />, {
      wrapper: harness.wrapper,
    });

    expect(screen.getByRole("link", { name: "Home Depot" })).toHaveAttribute(
      "href",
      "/vendors/VEN-ABCD",
    );
    expect(screen.getByRole("link", { name: "The Food Lab" })).toHaveAttribute(
      "href",
      "/cookbooks/CKB-EFGH",
    );
    expect(screen.getByText("Logo")).toBeInTheDocument();
    expect(screen.getByText("Cover")).toBeInTheDocument();
  });

  it("renders the ordinary empty value when nothing references an image", () => {
    render(<ImageAssociationLinks associations={[]} />, {
      wrapper: harness.wrapper,
    });
    expect(screen.queryByRole("link")).toBeNull();
  });
});
