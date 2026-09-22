import type { ImageShortcode } from "@cubby/schemas/identifiers";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { imageUpload } from "~/lib/image.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { UploadImageDialog } from "./upload-image-dialog";

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
  vi.restoreAllMocks();
});

function uploadedImageRow(imageId: ImageShortcode, file: File) {
  return {
    id: imageId,
    url: "https://storage.example.test/lemon.jpg",
    key: "lemon.jpg",
    filename: "lemon.jpg",
    size: file.size,
    contentType: "image/jpeg",
    status: "UPLOADED" as const,
    useOriginal: false,
    width: null,
    height: null,
    detectedContentType: null,
    sha256: null,
    renderStatus: null,
    storageStatus: null,
    verifiedAt: null,
    source: "unknown" as const,
    sourcePageUrl: null,
    sourceAssetUrl: null,
    sourceName: null,
    capturedAt: null,
    capturedAtOffsetMinutes: null,
    captureLocation: null,
    capturePlaceName: null,
    captureDeviceLabel: null,
    capturedByPartyId: null,
    capturedByName: null,
    captureAttribution: "none" as const,
    provenanceEvidence: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    entityType: null,
    entityId: null,
    entityName: null,
    associations: [],
  };
}

describe("UploadImageDialog", () => {
  it("retries only finalization after a successful PUT", async () => {
    const file = new File(["lemon"], "lemon.jpg", { type: "image/jpeg" });
    const imageId = testShortcode("image", "IMG-CKPT");
    let initializations = 0;
    let puts = 0;
    let finalizations = 0;
    const uploadImage = imageUpload.uploadImage.withTransport(async () => {
      initializations += 1;
      return {
        imageId,
        uploadUrl: "https://storage.example.test/upload",
        key: "lemon.jpg",
        url: "https://storage.example.test/lemon.jpg",
      };
    });
    const markUploaded = imageUpload.markUploaded.withTransport(async () => {
      finalizations += 1;
      if (finalizations === 1) throw new Error("finalize unavailable");
      return uploadedImageRow(imageId, file);
    });
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      puts += 1;
      expect(init?.body).toBe(file);
      return new Response(null, { status: 200 });
    });

    render(
      <UploadImageDialog
        operations={{
          uploadImage,
          markUploaded,
          importFromUrl: imageUpload.importFromUrl,
        }}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    fireEvent.change(await screen.findByLabelText("Choose images"), {
      target: { files: [file] },
    });

    expect(await screen.findByText("Upload failed")).toBeInTheDocument();
    expect(initializations).toBe(1);
    expect(puts).toBe(1);
    expect(finalizations).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(finalizations).toBe(2));
    await waitFor(() =>
      expect(screen.queryByText("Upload failed")).not.toBeInTheDocument(),
    );
    expect(initializations).toBe(1);
    expect(puts).toBe(1);
  });

  it("re-initializes and re-uploads after a failed PUT", async () => {
    const file = new File(["lemon"], "lemon.jpg", { type: "image/jpeg" });
    const imageId = testShortcode("image", "IMG-CKPT");
    let initializations = 0;
    let puts = 0;
    let finalizations = 0;
    const uploadImage = imageUpload.uploadImage.withTransport(async () => {
      initializations += 1;
      return {
        imageId,
        uploadUrl: "https://storage.example.test/upload",
        key: "lemon.jpg",
        url: "https://storage.example.test/lemon.jpg",
      };
    });
    const markUploaded = imageUpload.markUploaded.withTransport(async () => {
      finalizations += 1;
      return uploadedImageRow(imageId, file);
    });
    // First PUT fails outright (503): the fetch throws before a checkpoint is
    // ever assigned (use-image-upload.ts:90-99), so retry must redo BOTH the
    // presigned-URL init and the PUT, not just finalization (contrast with the
    // successful-PUT case above, which retries only markUploaded).
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      puts += 1;
      expect(init?.body).toBe(file);
      return new Response(null, { status: puts === 1 ? 503 : 200 });
    });

    render(
      <UploadImageDialog
        operations={{
          uploadImage,
          markUploaded,
          importFromUrl: imageUpload.importFromUrl,
        }}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    fireEvent.change(await screen.findByLabelText("Choose images"), {
      target: { files: [file] },
    });

    expect(await screen.findByText("Upload failed")).toBeInTheDocument();
    expect(initializations).toBe(1);
    expect(puts).toBe(1);
    expect(finalizations).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByText("Upload failed")).not.toBeInTheDocument(),
    );
    expect(initializations).toBe(2);
    expect(puts).toBe(2);
    expect(finalizations).toBe(1);
  });

  it("keeps the URL and re-enables Import when the import fails", async () => {
    const errorSpy = vi.spyOn(toast, "error").mockImplementation(() => "");
    const importFromUrl = imageUpload.importFromUrl.withTransport(async () => {
      throw new Error("import unavailable");
    });

    render(
      <UploadImageDialog
        operations={{
          uploadImage: imageUpload.uploadImage,
          markUploaded: imageUpload.markUploaded,
          importFromUrl,
        }}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    const urlInput = await screen.findByLabelText("From a URL");
    fireEvent.change(urlInput, {
      target: { value: "https://example.com/photo.jpg" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        "import unavailable",
        expect.objectContaining({ id: expect.any(String) }),
      ),
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    // Cleared only on success (upload-image-dialog.tsx onSuccess) — a failed
    // import must leave the typed URL in place so the user can just retry.
    expect(urlInput).toHaveValue("https://example.com/photo.jpg");
    expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
    expect(urlInput).toBeEnabled();
  });
});
