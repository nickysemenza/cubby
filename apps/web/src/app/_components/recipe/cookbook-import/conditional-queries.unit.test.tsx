import type { CookbookExtraction } from "@cubby/schemas/cookbook";
import { testShortcode } from "@cubby/schemas/testing";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recipe } from "~/app/recipes/recipe.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { BookGroupCard } from "./book-group-card";
import { CookbookImport } from "./index";
import type { Book, BookHandlers } from "./types";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  cleanup();
  harness.dispose();
});

const handlers: BookHandlers = {
  rename: vi.fn(),
  toggleRecipe: vi.fn(),
  toggleAll: vi.fn(),
  toggleExpanded: vi.fn(),
  remove: vi.fn(),
  import: vi.fn(),
  retryPhoto: vi.fn(),
  bindOriginalEpub: vi.fn(),
  extract: vi.fn(),
  cancel: vi.fn(),
  retryExtraction: vi.fn(),
};

const emptyExtraction: CookbookExtraction = {
  contract: "cookbook/1",
  source: {
    label: "example.epub",
    sha256: "0".repeat(64),
    title: "Example cookbook",
    authors: [],
    identifiers: [],
    subjects: [],
  },
  chapters: [],
  edges: [],
};

describe("cookbook import conditional queries", () => {
  it("opens the EPUB importer without a source cookbook", () => {
    render(<CookbookImport />, { wrapper: harness.wrapper });
    expect(screen.getByText("Drop .epub cookbooks here")).toBeVisible();
    expect(harness.queryClient.isFetching()).toBe(0);
  });

  it("reopens an existing cookbook and tolerates clearing and restoring its name", async () => {
    const cookbookId = testShortcode("cookbook", "CKB-2345");
    const name = "Example cookbook";
    harness.queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: Infinity },
    });
    harness.queryClient.setQueryData(
      recipe.getCookbookSource.queryKey({ cookbookId }),
      { id: cookbookId, name, cookbook: emptyExtraction, report: null },
    );
    harness.queryClient.setQueryData(
      recipe.getCookbookDiff.queryKey({ book: name }),
      [],
    );
    render(<CookbookImport loadCookbookId={cookbookId} />, {
      wrapper: harness.wrapper,
    });
    const input = await screen.findByRole("textbox", { name: "Book name" });
    expect(input).toHaveValue(name);
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: name } });
    expect(input).toHaveValue(name);
    expect(harness.queryClient.isFetching()).toBe(0);
  });

  it.each(["", "   "])(
    "allows an empty book name (%j) while editing",
    (name) => {
      const book: Book = {
        source: "example.epub",
        name,
        extraction: emptyExtraction,
        selected: new Set(),
        results: new Map(),
        photos: new Map(),
        photoPreviewUrls: new Map(),
        extract: { status: "ready" },
        expanded: false,
      };
      render(
        <BookGroupCard book={book} handlers={handlers} importing={false} />,
        {
          wrapper: harness.wrapper,
        },
      );
      expect(screen.getByRole("textbox", { name: "Book name" })).toHaveValue(
        name,
      );
      expect(harness.queryClient.isFetching()).toBe(0);
    },
  );
});
