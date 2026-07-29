import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFileUpload } from "./use-file-upload";

describe("useFileUpload", () => {
  const createObjectURL = vi.fn(() => "blob:preview");
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
  });

  it("validates accepted types and retains valid files", () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useFileUpload({
        accept: "image/png",
        multiple: true,
        onError,
      }),
    );

    act(() => {
      result.current[1].addFiles([
        new File(["ok"], "photo.png", { type: "image/png" }),
        new File(["no"], "notes.txt", { type: "text/plain" }),
      ]);
    });

    expect(result.current[0].files).toHaveLength(1);
    expect(result.current[0].files[0]?.file.name).toBe("photo.png");
    expect(result.current[0].errors[0]).toContain("not an accepted file type");
  });

  it("revokes generated previews on unmount", () => {
    const { result, unmount } = renderHook(() =>
      useFileUpload({ accept: "image/*" }),
    );

    act(() => {
      result.current[1].addFiles([
        new File(["image"], "photo.png", { type: "image/png" }),
      ]);
    });
    unmount();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });
});
