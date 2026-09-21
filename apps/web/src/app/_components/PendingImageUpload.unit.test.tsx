import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { imageUpload } from "~/lib/image.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { PendingImageUpload } from "./PendingImageUpload";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
  vi.stubGlobal("fetch", vi.fn());
  class TestURL extends URL {}
  Object.assign(TestURL, {
    createObjectURL: vi.fn((file: File) => `blob:${file.name}`),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal("URL", TestURL);
});

afterEach(() => {
  harness.dispose();
  vi.unstubAllGlobals();
});

function chooseImages(...files: File[]) {
  fireEvent.change(screen.getByLabelText("Choose image"), {
    target: { files },
  });
}

describe("PendingImageUpload", () => {
  it("keeps successful ids while a later photo fails, then retries only that file", async () => {
    const first = new File(["first"], "bed.jpg", { type: "image/jpeg" });
    const second = new File(["second"], "crop.jpg", { type: "image/jpeg" });
    const onImagesChange = vi.fn();
    let initializations = 0;
    let puts = 0;
    const uploadImage = imageUpload.uploadImage.withTransport(async () => {
      initializations += 1;
      return {
        imageId: testShortcode(
          "image",
          initializations === 1 ? "IMG-4K7M" : "IMG-9Q2X",
        ),
        uploadUrl: "https://storage.example.test/upload",
        key: `photo-${initializations}.jpg`,
        url: `https://storage.example.test/photo-${initializations}.jpg`,
      };
    });
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      puts += 1;
      expect(init?.body).toBe(puts === 1 ? first : second);
      return new Response(null, { status: puts === 2 ? 503 : 200 });
    });

    render(
      <PendingImageUpload
        entityType="PRODUCT"
        onImagesChange={onImagesChange}
        operations={{ uploadImage, importFromUrl: imageUpload.importFromUrl }}
      />,
      { wrapper: harness.wrapper },
    );

    chooseImages(first, second);
    expect(await screen.findByAltText("bed.jpg")).toBeInTheDocument();
    expect(await screen.findByAltText("crop.jpg")).toBeInTheDocument();
    expect(await screen.findAllByText("Upload failed")).toHaveLength(1);
    expect(onImagesChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "IMG-4K7M", filename: "bed.jpg" }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(onImagesChange).toHaveBeenLastCalledWith([
        expect.objectContaining({ id: "IMG-4K7M", filename: "bed.jpg" }),
        expect.objectContaining({ id: "IMG-9Q2X", filename: "crop.jpg" }),
      ]),
    );
    expect(initializations).toBe(3);
    expect(puts).toBe(3);
  });

  it("shows and removes a failed local preview without publishing an image", async () => {
    const crop = new File(["crop"], "crop.jpg", { type: "image/jpeg" });
    const onImagesChange = vi.fn();
    const uploadImage = imageUpload.uploadImage.withTransport(async () => ({
      imageId: testShortcode("image", "IMG-FAIL"),
      uploadUrl: "https://storage.example.test/upload",
      key: "crop.jpg",
      url: "https://storage.example.test/crop.jpg",
    }));
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
    render(
      <PendingImageUpload
        entityType="PRODUCT"
        onImagesChange={onImagesChange}
        operations={{ uploadImage, importFromUrl: imageUpload.importFromUrl }}
      />,
      { wrapper: harness.wrapper },
    );

    chooseImages(crop);
    expect(await screen.findByAltText("crop.jpg")).toBeInTheDocument();
    expect(await screen.findByText("Upload failed")).toBeInTheDocument();
    expect(onImagesChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove crop.jpg" }));
    await waitFor(() =>
      expect(screen.queryByAltText("crop.jpg")).not.toBeInTheDocument(),
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:crop.jpg");
  });

  it("keeps existing cover ordering and reports an individual removal", () => {
    const onExistingImagesReorder = vi.fn();
    const onExistingImagesRemove = vi.fn();
    render(
      <PendingImageUpload
        entityType="PRODUCT"
        existingImages={[
          {
            id: "IMG-COVER",
            url: "https://example.com/cover.jpg",
            filename: "Cover",
            key: "cover",
          },
          {
            id: "IMG-SECOND",
            url: "https://example.com/second.jpg",
            filename: "Second",
            key: "second",
          },
        ]}
        onExistingImagesReorder={onExistingImagesReorder}
        onExistingImagesRemove={onExistingImagesRemove}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(screen.getByTitle("Make cover"));
    expect(onExistingImagesReorder).toHaveBeenCalledWith([
      "IMG-SECOND",
      "IMG-COVER",
    ]);
    fireEvent.click(screen.getByRole("button", { name: /remove cover/i }));
    expect(onExistingImagesRemove).toHaveBeenCalledWith(["IMG-COVER"]);
  });

  it("reports an explicit role correction for an existing Product image", () => {
    const onExistingImagesPurposeChange = vi.fn();
    render(
      <PendingImageUpload
        entityType="PRODUCT"
        existingImages={[
          {
            id: "IMG-EXISTING",
            url: "https://example.com/existing.jpg",
            filename: "Existing photo",
            key: "existing",
            purpose: "item",
          },
        ]}
        onExistingImagesPurposeChange={onExistingImagesPurposeChange}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.change(
      screen.getByLabelText("Attachment role for Existing photo"),
      { target: { value: "label" } },
    );
    expect(onExistingImagesPurposeChange).toHaveBeenLastCalledWith({
      "IMG-EXISTING": "label",
    });
  });

  it("imports a URL into the pending list without attaching a record", async () => {
    const onImagesChange = vi.fn();
    const importFromUrl = imageUpload.importFromUrl.withTransport(async () => ({
      imageId: testShortcode("image", "IMG-URL1"),
      key: "imported.jpg",
      url: "https://storage.example.test/imported.jpg",
      filename: "imported.jpg",
    }));
    render(
      <PendingImageUpload
        entityType="PRODUCT"
        onImagesChange={onImagesChange}
        operations={{ uploadImage: imageUpload.uploadImage, importFromUrl }}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.change(screen.getByPlaceholderText("Paste image URL..."), {
      target: { value: "https://example.com/garden.jpg" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByAltText("imported.jpg")).toBeInTheDocument();
    expect(onImagesChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: expect.stringMatching(/^IMG-/),
        filename: "imported.jpg",
      }),
    ]);
  });

  it("sends the selected source with a local upload", async () => {
    const file = new File(["catalog"], "catalog.jpg", { type: "image/jpeg" });
    const onImagesChange = vi.fn();
    const uploadImage = imageUpload.uploadImage.withTransport(async (input) => {
      expect(input.input.source).toBe("catalog");
      return {
        imageId: testShortcode("image", "IMG-CATALOG"),
        uploadUrl: "https://storage.example.test/upload",
        key: "catalog.jpg",
        url: "https://storage.example.test/catalog.jpg",
      };
    });
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));
    render(
      <PendingImageUpload
        entityType="PRODUCT"
        onImagesChange={onImagesChange}
        operations={{ uploadImage, importFromUrl: imageUpload.importFromUrl }}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.change(screen.getByLabelText("Photo source"), {
      target: { value: "catalog" },
    });
    fireEvent.change(screen.getByLabelText("Attach as"), {
      target: { value: "label" },
    });
    chooseImages(file);
    expect(await screen.findByAltText("catalog.jpg")).toBeInTheDocument();
    expect(onImagesChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ purpose: "label" }),
    ]);
  });

  it("accepts a pasted image through the same pending upload path", async () => {
    const pasted = new File(["clipboard"], "clipboard.png", {
      type: "image/png",
    });
    const onImagesChange = vi.fn();
    const uploadImage = imageUpload.uploadImage.withTransport(async () => ({
      imageId: testShortcode("image", "IMG-PAST"),
      uploadUrl: "https://storage.example.test/upload",
      key: "clipboard.png",
      url: "https://storage.example.test/clipboard.png",
    }));
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));
    render(
      <PendingImageUpload
        entityType="PRODUCT"
        onImagesChange={onImagesChange}
        operations={{ uploadImage, importFromUrl: imageUpload.importFromUrl }}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.paste(document, {
      clipboardData: {
        items: [
          {
            type: "image/png",
            getAsFile: () => pasted,
          },
        ],
      },
    });

    await waitFor(() =>
      expect(onImagesChange).toHaveBeenCalledWith([
        expect.objectContaining({
          filename: expect.stringMatching(/^pasted-image-.*\.png$/),
        }),
      ]),
    );
  });
});
