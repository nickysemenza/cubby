import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});

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
      return {
        id: imageId,
        url: "https://storage.example.test/lemon.jpg",
        key: "lemon.jpg",
        filename: "lemon.jpg",
        size: file.size,
        contentType: "image/jpeg",
        status: "UPLOADED",
        width: null,
        height: null,
        detectedContentType: null,
        sha256: null,
        renderStatus: null,
        storageStatus: null,
        verifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        entityType: null,
        entityId: null,
        entityName: null,
        associations: [],
      };
    });
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      puts += 1;
      expect(init?.body).toBe(file);
      return new Response(null, { status: 200 });
    });

    render(<UploadImageDialog operations={{ uploadImage, markUploaded }} />, {
      wrapper: harness.wrapper,
    });
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
});
