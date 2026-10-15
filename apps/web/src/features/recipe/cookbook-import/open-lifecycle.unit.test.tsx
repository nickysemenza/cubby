import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { CookbookImport } from "./index";

// The EPUB package loads lazily; a book removed (or a page left) before it
// arrives must not get a wasm handle nobody frees.
const openBook = vi.fn();
let release = () => {};
const loadEpubModule = () =>
  new Promise<{ open_book: typeof openBook }>((resolve) => {
    release = () => resolve({ open_book: openBook });
  });

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
  openBook.mockClear();
});
afterEach(() => {
  cleanup();
  harness.dispose();
});

function dropEpub(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>(
    'input[accept*=".epub"]',
  );
  if (!input) throw new Error("EPUB file input is missing");
  fireEvent.change(input, {
    target: {
      files: [new File([new Uint8Array([1])], "example.epub")],
    },
  });
}

describe("cookbook EPUB open lifecycle", () => {
  it("does not open a book removed while its module loads", async () => {
    const { container } = render(
      <CookbookImport loadEpubModule={loadEpubModule} />,
      {
        wrapper: harness.wrapper,
      },
    );
    dropEpub(container);
    fireEvent.click(await screen.findByRole("button", { name: "Remove book" }));
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(openBook).not.toHaveBeenCalled();
  });

  it("does not open a book after the page unmounts", async () => {
    const { container, unmount } = render(
      <CookbookImport loadEpubModule={loadEpubModule} />,
      {
        wrapper: harness.wrapper,
      },
    );
    dropEpub(container);
    await screen.findByRole("button", { name: "Remove book" });
    unmount();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(openBook).not.toHaveBeenCalled();
  });
});
