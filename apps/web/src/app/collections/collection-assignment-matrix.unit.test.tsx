import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  matrix: {
    data: {
      collections: ["painting", "kitchen"],
      rows: [
        {
          id: "PRD-PAINT",
          name: "Primer",
          secondary: "Example paint",
          imageUrl: null,
          placements: [],
          purchases: [],
          states: { painting: "direct", kitchen: "inherited" },
        },
      ],
      totalCount: 1,
    },
    error: null as Error | null,
    isLoading: false,
    refetch: vi.fn(),
  },
  mutate: vi.fn(),
  onSearchChange: vi.fn(),
  queryOptions: vi.fn(() => ({ queryKey: ["collection", "matrix"] })),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ isPending: false, mutate: mocks.mutate }),
  useQuery: () => mocks.matrix,
  useQueryClient: () => ({}),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props} href="/collections">
      {children}
    </a>
  ),
}));
vi.mock("~/components/layout", () => ({
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("~/components/matrix/cross-tab-table", () => ({
  CrossTabTable: () => <div data-testid="desktop-matrix" />,
}));
vi.mock("~/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: () => null,
  DialogDescription: () => null,
  DialogFooter: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null,
  DialogTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
}));
vi.mock("~/components/ui/image", () => ({
  Image: ({ alt }: { alt: string }) => <img src="/test-image.png" alt={alt} />,
}));
vi.mock("~/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));
vi.mock("~/components/ui/label", () => ({
  Label: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("~/components/ui/native-select", () => ({
  NativeSelect: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => (
    <select {...props} />
  ),
}));
vi.mock("~/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("~/entities/entities", () => ({
  EntityIcon: () => <span />,
  entityDetailLink: () => ({ to: "/collections" }),
}));
vi.mock("~/lib/error-utils", () => ({
  getErrorMessage: (error: Error) => error.message,
}));
vi.mock("./collection.functions", () => ({
  collection: {
    create: { mutationOptions: () => ({}) },
    matrix: { queryOptions: mocks.queryOptions },
    set: { mutationOptions: () => ({}) },
  },
}));
vi.mock("./collection-product-context", () => ({
  CopyableShortcode: () => null,
  ProductContextLine: () => null,
}));

import { CollectionAssignmentMatrix } from "./collection-assignment-matrix";

function renderMatrix() {
  return render(
    <CollectionAssignmentMatrix
      subject="product"
      page={1}
      pageSize={100}
      sort="name-asc"
      onSearchChange={mocks.onSearchChange}
    />,
  );
}

describe("CollectionAssignmentMatrix mobile projection", () => {
  beforeEach(() => {
    mocks.matrix.data = {
      collections: ["painting", "kitchen"],
      rows: [
        {
          id: "PRD-PAINT",
          name: "Primer",
          secondary: "Example paint",
          imageUrl: null,
          placements: [],
          purchases: [],
          states: { painting: "direct", kitchen: "inherited" },
        },
      ],
      totalCount: 1,
    };
    mocks.matrix.error = null;
    mocks.matrix.isLoading = false;
    mocks.matrix.refetch.mockReset();
    mocks.mutate.mockReset();
    mocks.onSearchChange.mockReset();
    mocks.queryOptions.mockClear();
  });

  it("keeps a phone assignment target separate from the matrix filter", () => {
    renderMatrix();

    const collectionTarget = screen.getByRole("combobox", {
      name: "Assign to Collection",
    });
    expect(collectionTarget).toHaveValue("painting");
    expect(
      screen.getByRole("button", {
        name: "Remove direct Painting assignment for Primer",
      }),
    ).toBeVisible();

    fireEvent.change(collectionTarget, { target: { value: "kitchen" } });

    expect(collectionTarget).toHaveValue("kitchen");
    expect(
      screen.getByRole("button", {
        name: "Add direct Kitchen assignment for Primer; inherited membership remains",
      }),
    ).toBeVisible();
    expect(mocks.onSearchChange).not.toHaveBeenCalled();
  });

  it("optimistically changes a direct assignment on the selected target", () => {
    renderMatrix();

    const assignment = screen.getByRole("button", {
      name: "Remove direct Painting assignment for Primer",
    });
    fireEvent.click(assignment);

    expect(assignment).toHaveAttribute("aria-pressed", "false");
    expect(assignment).toHaveTextContent("Assign");
  });

  it("keeps a thumb-sized detail link beside the assignment control", () => {
    renderMatrix();

    expect(screen.getByRole("link", { name: "Primer" })).toHaveClass(
      "min-h-11",
    );
  });

  it("keeps the mobile subject selector and valid creation path when empty", () => {
    mocks.matrix.data = {
      collections: [],
      rows: [
        {
          id: "PRD-PAINT",
          name: "Primer",
          secondary: "Example paint",
          imageUrl: null,
          placements: [],
          purchases: [],
          states: { painting: "empty", kitchen: "empty" },
        },
      ],
      totalCount: 1,
    };

    renderMatrix();

    expect(
      screen.getByRole("combobox", { name: "Assignment subject" }),
    ).toHaveValue("product");
    expect(screen.getByText("No Collections yet")).toBeVisible();
    expect(
      screen
        .getAllByRole("button", { name: "New Collection" })
        .some((button) => !button.hasAttribute("disabled")),
    ).toBe(true);
  });

  it("keeps the phone ledger to 25 rows while paging within the fetched batch", () => {
    mocks.matrix.data = {
      collections: ["painting"],
      rows: Array.from({ length: 26 }, (_, index) => ({
        id: `PRD-${index + 1}`,
        name: `Product ${index + 1}`,
        secondary: "Example paint",
        imageUrl: null,
        placements: [],
        purchases: [],
        states: { painting: "empty", kitchen: "empty" },
      })),
      totalCount: 26,
    };

    renderMatrix();

    expect(screen.getByText("Product 25")).toBeVisible();
    expect(screen.queryByText("Product 26")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Next 25 assignments" }),
    );

    expect(screen.getByText("Product 26")).toBeVisible();
    expect(mocks.onSearchChange).not.toHaveBeenCalled();
  });

  it("distinguishes a failed matrix load and offers retry", () => {
    mocks.matrix.data = undefined as unknown as typeof mocks.matrix.data;
    mocks.matrix.error = new Error("Collection service unavailable");

    renderMatrix();

    expect(screen.getAllByText("Couldn’t load assignments")).toHaveLength(2);
    expect(screen.getAllByText("Collection service unavailable")).toHaveLength(
      2,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]!);
    expect(mocks.matrix.refetch).toHaveBeenCalledOnce();
  });
});
