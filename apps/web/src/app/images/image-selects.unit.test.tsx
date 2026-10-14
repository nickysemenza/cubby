import type { ImageWithEntity } from "@cubby/schemas/image";
import { fireEvent, render, screen } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AttachExistingImageDialog } from "~/features/images/attach-existing-image-dialog";
import { search } from "~/integrations/tanstack-query/generated/catalog.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ImageEditDialog } from "./image-edit-dialog";

const image = fromPartial<ImageWithEntity>({
  id: "IMG-4K7M",
  filename: "illustrative.png",
  source: "unknown",
  sourceName: null,
  sourcePageUrl: null,
  sourceAssetUrl: null,
  associations: [],
});

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function choose(control: HTMLElement, option: string) {
  control.focus();
  fireEvent.keyDown(control, { key: "ArrowDown" });
  // A real click starts on the option; choose-mode pickers ignore a click
  // whose pointer went down on the trigger.
  const item = screen.getByRole("option", { name: option });
  fireEvent.pointerDown(item);
  fireEvent.click(item);
}

describe("image dialog pickers", () => {
  it("keeps the chosen image source", async () => {
    render(<ImageEditDialog record={image} onClose={vi.fn()} />, {
      wrapper: harness.wrapper,
    });

    const source = await screen.findByRole("combobox", { name: "Source" });
    expect(source).toHaveTextContent("Unknown");
    choose(source, "Catalog");
    expect(source).toHaveTextContent("Catalog");
    choose(source, "Our photo");
    expect(source).toHaveTextContent("Our photo");
  });

  it("picks the target record from search and keeps the product image purpose", async () => {
    render(
      <AttachExistingImageDialog
        image={image}
        onClose={vi.fn()}
        findTargets={search.find.withTransport(async () => [
          {
            id: "PRD-4K7M",
            entityKind: "product",
            title: "Example oats",
            subtitle: null,
            typeHint: null,
            imageUrl: null,
            matchKind: "text",
            matchField: "title",
            matchReason: "Name",
            matchTerms: ["oats"],
          },
        ])}
      />,
      { wrapper: harness.wrapper },
    );

    const target = await screen.findByRole("combobox", { name: "Record" });
    target.focus();
    fireEvent.keyDown(target, { key: "ArrowDown" });
    fireEvent.change(target, { target: { value: "oats" } });
    const hit = await screen.findByRole("option", { name: /Example oats/ });
    fireEvent.click(hit);
    // The record's name shows, never its code.
    expect(target).toHaveValue("Example oats");
    const purpose = await screen.findByRole("combobox", {
      name: "Product image use",
    });
    choose(purpose, "Label or tag");
    expect(purpose).toHaveTextContent("Label or tag");
  });
});
