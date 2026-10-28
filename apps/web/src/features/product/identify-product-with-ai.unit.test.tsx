import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEditorBrowserTestHarness as createBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";

import { IdentifyProductButton } from "./identify-product-with-ai";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("IdentifyProductButton", () => {
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
