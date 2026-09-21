import { productWithFoodOut } from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { entityMutation } from "~/entities/entity-mutation.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import { entityBrowserMutationResultSchema } from "~/server/entity-kernel/contracts";

import { ProductEditDialog } from "./product-edit-dialog";

const product = mock(productWithFoodOut, {
  seed: 37,
  overrides: {
    id: testShortcode("product", "PRD-4K7M"),
    name: "Original product",
    images: [],
    labelImages: [],
    unitMappings: [],
    externalIds: [],
  },
});

const savedProduct = entityBrowserMutationResultSchema.parse({
  action: "update",
  entity: "product",
  item: product,
  sideEffects: { backgroundBatches: [] },
});

let harness: ReturnType<typeof createBrowserTestHarness>;
let transport = vi.fn(async () => savedProduct);

beforeEach(() => {
  harness = createBrowserTestHarness();
  const originalForEntity = entityMutation.mutate.forEntity.bind(
    entityMutation.mutate,
  );
  transport = vi.fn(async () => savedProduct);
  vi.spyOn(entityMutation.mutate, "forEntity").mockImplementation((entity) =>
    originalForEntity(entity).withTransport(transport),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  harness.dispose();
});

function renderDialog(onClose = vi.fn()) {
  render(<ProductEditDialog record={product} onClose={onClose} />, {
    wrapper: harness.wrapper,
  });
  return onClose;
}

function changeName(name: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: name },
  });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

describe("ProductEditDialog", () => {
  it("keeps the pending product override open for Escape and backdrop dismissal", async () => {
    let finishSave: (() => void) | undefined;
    const pendingSave = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    transport.mockImplementation(async () => {
      await pendingSave;
      return savedProduct;
    });

    const onClose = renderDialog();
    changeName("Updated product");
    submit();

    await waitFor(() => expect(transport).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerDown(
      document.querySelector('[data-slot="dialog-overlay"]')!,
      { button: 0 },
    );

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Edit product" })).toBeVisible();

    finishSave?.();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("retains the edited draft after a failed product override save", async () => {
    transport.mockRejectedValueOnce(new Error("Save failed"));

    const onClose = renderDialog();
    changeName("Updated product");
    submit();

    await screen.findByText("Save failed");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Updated product",
    );
    expect(screen.getByRole("dialog", { name: "Edit product" })).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });
});
