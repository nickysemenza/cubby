import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PendingImage } from "~/app/_components/PendingImageUpload";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { IdentifyProductButton } from "./identify-product-with-ai";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

const existingImage: PendingImage = {
  id: "IMG-EXIST",
  url: "https://r2.example.com/existing.jpg",
  filename: "existing.jpg",
  key: "products/existing.jpg",
};

describe("IdentifyProductButton", () => {
  // The regression this guards: the button used to read only
  // `pendingImages` (this session's uploads), so a product edited with no
  // NEW photo — only an already-attached one — showed the button disabled
  // even though a perfectly good photo was sitting right there.
  it("enables from an existing image alone, with no pending upload", () => {
    render(
      <IdentifyProductButton
        form={{ setValue: () => {} }}
        existingImages={[existingImage]}
        pendingImages={[]}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      screen.getByRole("button", { name: "Identify product" }),
    ).toBeEnabled();
  });

  it("disables with neither an existing nor a pending image", () => {
    render(
      <IdentifyProductButton
        form={{ setValue: () => {} }}
        existingImages={[]}
        pendingImages={[]}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      screen.getByRole("button", { name: /Identify product/ }),
    ).toBeDisabled();
  });
});
