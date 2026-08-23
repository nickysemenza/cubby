// @vitest-environment happy-dom

import type { ImageAssociation } from "@cubby/schemas/image";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImageAssociationLinks } from "./image-associations";

vi.mock("~/app/_components/EntityInlineLink", () => ({
  EntityInlineLink: ({
    entity,
    data,
  }: {
    entity: string;
    data: { id: string; name?: string; orderId?: string | null };
  }) => (
    <a href={`/${entity}s/${data.id}`}>
      {data.name ?? data.orderId ?? data.id}
    </a>
  ),
}));

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

describe("ImageAssociationLinks", () => {
  it("links every direct association and identifies each relationship role", () => {
    render(<ImageAssociationLinks associations={associations} showRole />);

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
    render(<ImageAssociationLinks associations={[]} />);
    expect(document.querySelector("a")).toBeNull();
  });
});
