import type { ImageWithEntity } from "@cubby/schemas/image";
import { fireEvent, render, screen } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AttachExistingImageDialog } from "~/app/_components/images/attach-existing-image-dialog";
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

describe("image dialog native selects", () => {
  it("accepts a valid source and maps an unknown value back to unknown", async () => {
    render(<ImageEditDialog record={image} onClose={vi.fn()} />, {
      wrapper: harness.wrapper,
    });

    const source = await screen.findByRole("combobox", { name: "Source" });
    fireEvent.change(source, { target: { value: "catalog" } });
    expect(source).toHaveValue("catalog");
    fireEvent.change(source, { target: { value: "unsupported" } });
    expect(source).toHaveValue("unknown");
  });

  it("keeps the product image purpose as a controlled native selection", async () => {
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
    fireEvent.change(purpose, { target: { value: "label" } });
    expect(purpose).toHaveValue("label");
  });
});
