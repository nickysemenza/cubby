import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileDropField } from "./FileDropField";

const file = (name: string, type: string, size = 1) =>
  new File([new Uint8Array(size)], name, { type });

function input(label = "Upload") {
  const element = screen.getByLabelText(label, {
    selector: "input",
  });
  if (!(element instanceof HTMLInputElement))
    throw new Error(`${label} is not a file input`);
  return element;
}

describe("FileDropField", () => {
  it("accepts matching MIME files from the input and renders type errors", async () => {
    const onFilesAdded = vi.fn();
    render(
      <FileDropField
        accept="image/png"
        label="Upload"
        multiple
        onFilesAdded={onFilesAdded}
      />,
    );

    fireEvent.change(input(), {
      target: {
        files: [
          file("photo.png", "image/png"),
          file("notes.txt", "text/plain"),
        ],
      },
    });

    await waitFor(() =>
      expect(onFilesAdded).toHaveBeenCalledWith([
        expect.objectContaining({ name: "photo.png" }),
      ]),
    );
    expect(await screen.findByText(/file type/i)).toBeInTheDocument();
  });

  it("accepts configured extensions and applies max-size and max-count rejections", async () => {
    const onFilesAdded = vi.fn();
    const { rerender, unmount } = render(
      <FileDropField
        accept=".epub,application/epub+zip"
        label="Upload"
        onFilesAdded={onFilesAdded}
      />,
    );

    fireEvent.change(input(), {
      target: { files: [file("book.epub", "application/octet-stream")] },
    });
    await waitFor(() =>
      expect(onFilesAdded).toHaveBeenCalledWith([
        expect.objectContaining({ name: "book.epub" }),
      ]),
    );

    rerender(
      <FileDropField
        accept="image/*"
        label="Upload"
        maxFiles={1}
        maxSize={2}
        multiple
        onFilesAdded={onFilesAdded}
      />,
    );
    fireEvent.change(input(), {
      target: { files: [file("large.png", "image/png", 3)] },
    });
    expect(
      await screen.findByText("Some files exceed the maximum size of 2 bytes."),
    ).toBeInTheDocument();

    unmount();
    render(
      <FileDropField
        accept="image/*"
        label="Upload"
        maxFiles={1}
        multiple
        onFilesAdded={onFilesAdded}
      />,
    );
    fireEvent.change(input(), {
      target: {
        files: [file("one.png", "image/png"), file("two.png", "image/png")],
      },
    });
    expect(
      await screen.findByText("You can only upload a maximum of 1 files."),
    ).toBeInTheDocument();
  });

  it("uses the drop handler, honors single-file mode, and disables both affordances", async () => {
    const onFilesAdded = vi.fn();
    const { rerender } = render(
      <FileDropField
        accept="image/*"
        label="Upload"
        onFilesAdded={onFilesAdded}
      />,
    );
    const dropzone = screen.getByRole("button", { name: /upload/i });
    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [file("one.png", "image/png"), file("two.png", "image/png")],
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => file("one.png", "image/png"),
          },
        ],
        types: ["Files"],
      },
    });
    await waitFor(() =>
      expect(onFilesAdded).toHaveBeenCalledWith([
        expect.objectContaining({ name: "one.png" }),
      ]),
    );

    rerender(
      <FileDropField
        accept="image/*"
        disabled
        label="Upload"
        onFilesAdded={onFilesAdded}
      />,
    );
    expect(input()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();

    rerender(
      <FileDropField
        accept="image/*"
        disabled
        label="Upload"
        mode="compact"
        onFilesAdded={onFilesAdded}
      />,
    );
    expect(input()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
  });

  it("opens the native file dialog from the compact button", () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click");
    render(
      <FileDropField
        accept="application/pdf"
        label="Choose document"
        mode="compact"
        onFilesAdded={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose document" }));

    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  });
});
