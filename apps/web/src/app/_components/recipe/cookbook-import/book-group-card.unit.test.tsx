import type {
  CookbookExtraction,
  CookbookIngredientLine,
  CookbookRecipe,
  CookbookRunReport,
} from "@cubby/schemas/cookbook";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ingredient } from "~/app/ingredients/ingredient.functions";
import { recipe } from "~/app/recipes/recipe.functions";
import { addWithDependencies } from "~/lib/cookbook-graph";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { BookGroupCard } from "./book-group-card";
import type { Book, BookHandlers } from "./types";

/**
 * A small but complete book tree: every feature the review has to render is
 * present exactly once — a chapter, a non-importable essay, and two recipes
 * where one depends on the other through a resolved ingredient reference (with
 * the matching dependency edge). A failure here names the feature that broke.
 */
const ingredientLine = (
  raw: string,
  name: string,
  ref?: CookbookIngredientLine["ref"],
): CookbookIngredientLine => ({
  raw,
  line: 0,
  parsed: { name, amounts: [] },
  confidence: "high",
  ref: ref ?? null,
});

const span = { start: 0, end: 10, doc_path: "text/ch01.xhtml" };

const pieDough: CookbookRecipe = {
  kind: "recipe",
  id: "r-dough",
  title: "Pie Dough",
  name: "Pie Dough",
  meta: { description: ["A plain all-butter dough."], equipment: [] },
  sections: [
    {
      ingredients: [ingredientLine("2 cups flour", "flour")],
      steps: [{ text: "Cut the butter into the flour.", line: 3, refs: [] }],
    },
  ],
  photos: [{ path: "images/dough.jpg", mime: "image/jpeg" }],
  notes: [],
  span,
};

const applePie: CookbookRecipe = {
  kind: "recipe",
  id: "r-pie",
  title: "Apple Pie",
  name: "Apple Pie",
  meta: {
    description: [],
    recipe_yield: "Makes one 9-inch pie",
    equipment: [],
  },
  sections: [
    {
      ingredients: [
        ingredientLine("1 recipe Pie Dough", "pie dough", {
          target_id: "r-dough",
          text: "Pie Dough",
          kind: "ingredient",
          method: "title",
        }),
        ingredientLine("6 apples", "apples"),
      ],
      steps: [{ text: "Fill and bake.", line: 8, refs: [] }],
    },
  ],
  photos: [],
  notes: [],
  span,
};

const extraction: CookbookExtraction = {
  contract: "cookbook/1",
  source: {
    label: "pies.epub",
    sha256: "f".repeat(64),
    title: "Pies",
    authors: ["A. Baker"],
    identifiers: [],
    subjects: ["Baking"],
  },
  chapters: [
    {
      id: "ch00",
      title: "Pies",
      items: [
        {
          kind: "essay",
          id: "e-butter",
          title: "On Butter",
          name: "On Butter",
          photos: [],
          span,
        },
        applePie,
        pieDough,
      ],
    },
  ],
  edges: [
    { from: "r-pie", to: "r-dough", kind: "ingredient", method: "title" },
  ],
};

/** A run that finished but left something behind: a failed chunk, a missing title. */
const report: CookbookRunReport = {
  run_id: "run-1",
  started_at: "2026-09-10T10:00:00Z",
  finished_at: "2026-09-10T10:01:05Z",
  total_cost_usd: 0.42,
  cost_complete: true,
  wall_ms: 65_000,
  incomplete: true,
  cancelled: false,
  calls: [
    {
      seq: 1,
      chunk_id: "c1",
      model: "claude-haiku",
      purpose: "extract",
      attempt: 1,
      latency_ms: 1200,
      cached: false,
      status: 200,
      cost_usd: 0.01,
      truncated: false,
      outcome: { outcome: "ok" },
    },
  ],
  chunks: [
    {
      id: "c2",
      start: 100,
      end: 200,
      status: "failed",
      final_model: "claude-sonnet",
      attempts: 3,
      flags: [],
      recipes: 0,
      cached: false,
    },
  ],
  crosscheck: {
    nav_titles: 3,
    matched: 2,
    missing: ["Cherry Pie"],
    phantom: [],
    recall: 0.67,
  },
  usage_by_model: [{ model: "claude-haiku", calls: 4, cost_usd: 0.42 }],
};

const BOOK_NAME = "Pies";

const baseBook = (overrides: Partial<Book> = {}): Book => ({
  source: "pies.epub",
  name: BOOK_NAME,
  selected: new Set<string>(),
  results: new Map(),
  photos: new Map(),
  photoPreviewUrls: new Map(),
  extract: { status: "ready" },
  expanded: true,
  ...overrides,
});

const handlers = (overrides: Partial<BookHandlers> = {}): BookHandlers => ({
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
  ...overrides,
});

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
  harness.queryClient.setDefaultOptions({
    queries: { retry: false, staleTime: Infinity },
  });
  // Nothing has been imported from this book yet, so every recipe reads "new".
  harness.queryClient.setQueryData(
    recipe.getCookbookDiff.queryKey({ book: BOOK_NAME }),
    [],
  );
  // The cards look their ingredient names up in one batched query each; seed
  // both so the review renders without reaching for the network.
  harness.queryClient.setQueryData(
    ingredient.matchNames.queryKey({ names: ["pie dough", "apples"] }),
    {},
  );
  harness.queryClient.setQueryData(
    ingredient.matchNames.queryKey({ names: ["flour"] }),
    {},
  );
});

afterEach(() => {
  cleanup();
  harness.dispose();
});

describe("cookbook book card", () => {
  it("prices the run before spending anything", () => {
    render(
      <BookGroupCard
        book={baseBook({
          extract: { status: "opened" },
          outline: {
            title: "Pies",
            authors: ["A. Baker"],
            chapters: 4,
            navRecipeTitles: 12,
            lines: 9000,
          },
          estimate: {
            chunks: 6,
            lines: 9000,
            inputTokens: 120_000,
            outputTokens: 24_000,
            costLow: 0.5,
            costHigh: 1.2,
            wallMsLow: 180_000,
            wallMsHigh: 420_000,
            ladder: ["claude-haiku", "claude-sonnet"],
            concurrency: 8,
            assumptions: ["Prices from the catalog of 2026-09-01"],
          },
        })}
        handlers={handlers()}
        importing={false}
      />,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByText("$0.50–$1.20")).toBeVisible();
    expect(screen.getByText(/6 chunks/)).toBeVisible();
    expect(screen.getByText(/~3–7 min/)).toBeVisible();
    expect(screen.getByText(/claude-haiku → claude-sonnet/)).toBeVisible();
    expect(
      screen.getByText("Prices from the catalog of 2026-09-01"),
    ).toBeVisible();
    // The tree does not exist yet, and nothing may start on its own.
    expect(screen.queryByText("Apple Pie")).toBeNull();
    expect(screen.getByRole("button", { name: /Extract/ })).toBeVisible();
  });

  it("starts extracting only when asked", () => {
    const onExtract = vi.fn();
    render(
      <BookGroupCard
        book={baseBook({
          extract: { status: "opened" },
          estimate: {
            chunks: 1,
            lines: 10,
            inputTokens: 100,
            outputTokens: 10,
            costLow: 0.01,
            costHigh: 0.02,
            wallMsLow: 1000,
            wallMsHigh: 2000,
            ladder: [],
            concurrency: 8,
            assumptions: [],
          },
        })}
        handlers={handlers({ extract: onExtract })}
        importing={false}
      />,
      { wrapper: harness.wrapper },
    );

    expect(onExtract).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Extract/ }));
    expect(onExtract).toHaveBeenCalledWith("pies.epub");
  });

  it("shows the whole book, with non-recipes as context", () => {
    render(
      <BookGroupCard
        book={baseBook({ extraction, selected: new Set(["r-pie", "r-dough"]) })}
        handlers={handlers()}
        importing={false}
      />,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByText("Pies")).toBeVisible();
    expect(screen.getByText("Apple Pie")).toBeVisible();
    expect(screen.getByText("Pie Dough")).toBeVisible();
    // The essay is counted, but is not a selectable row.
    expect(screen.getByText(/1 technique \/ essay/)).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Select On Butter" })).toBe(
      null,
    );
    // The sub-recipe reference reads as a link, not as a new ingredient.
    expect(screen.getByRole("button", { name: /→ Pie Dough/ })).toBeVisible();
  });

  it("surfaces what the run lost", () => {
    render(
      <BookGroupCard
        book={baseBook({ extraction, report, hasArchiveBytes: true })}
        handlers={handlers()}
        importing={false}
      />,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByText(/1 chunk failed/)).toBeVisible();
    expect(screen.getByText(/c2 · lines 100–200/)).toBeVisible();
    expect(screen.getByText(/claude-sonnet/)).toBeVisible();
    expect(screen.getByText(/Cherry Pie/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Retry extraction/ }),
    ).toBeVisible();
    expect(screen.getByText(/Run report — \$0\.42/)).toBeVisible();
  });

  it("selecting a recipe pulls in the sub-recipes it depends on", () => {
    // The cascade lives in the page's toggle handler, not the card, so the
    // harness owns selection exactly as the page does — by tree item id.
    function StatefulCard() {
      const [selected, setSelected] = useState(new Set<string>());
      return (
        <BookGroupCard
          book={baseBook({ extraction, selected })}
          handlers={handlers({
            toggleRecipe: (_source, id) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else addWithDependencies(extraction, next, id);
                return next;
              }),
          })}
          importing={false}
        />
      );
    }

    render(<StatefulCard />, { wrapper: harness.wrapper });

    const pie = screen.getByRole("checkbox", { name: "Select Apple Pie" });
    const dough = screen.getByRole("checkbox", { name: "Select Pie Dough" });
    expect(pie).not.toBeChecked();
    expect(dough).not.toBeChecked();

    fireEvent.click(pie);

    // Pie Dough was never clicked: it came along because Apple Pie uses it, so
    // the sub-recipe link resolves on import instead of becoming an ingredient.
    expect(
      screen.getByRole("checkbox", { name: "Select Apple Pie" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select Pie Dough" }),
    ).toBeChecked();
    expect(screen.getByRole("button", { name: /Import 2/ })).toBeVisible();
  });
});
