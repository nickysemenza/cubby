import type { ImageWithEntity } from "@cubby/schemas/image";
import { fireEvent, render, screen } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AttachExistingImageDialog } from "~/features/images/attach-existing-image-dialog";
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

  it("keeps the product image purpose as a controlled selection", async () => {
    render(<AttachExistingImageDialog image={image} onClose={vi.fn()} />, {
      wrapper: harness.wrapper,
    });

    fireEvent.change(
      await screen.findByRole("textbox", { name: "Record shortcode" }),
      {
        target: { value: "PRD-4K7M" },
      },
    );
    const purpose = await screen.findByRole("combobox", {
      name: "Product image use",
    });
    choose(purpose, "Label or tag");
    expect(purpose).toHaveTextContent("Label or tag");
  });
});
