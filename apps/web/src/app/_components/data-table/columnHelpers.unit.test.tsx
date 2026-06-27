import { createColumnHelper } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

// Mock dependencies
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: React.ReactNode;
    to: string;
    params?: object;
  }) => (
    <a href={to} data-params={JSON.stringify(params)}>
      {children}
    </a>
  ),
}));

vi.mock("lucide-react", () => ({
  Eye: () => <span data-testid="eye-icon">Eye</span>,
  ImageIcon: () => <span data-testid="image-icon">Img</span>,
  MoreHorizontal: () => <span data-testid="more-icon">...</span>,
}));

vi.mock("~/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    variant,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    variant?: string;
  }) => (
    <button type="button" onClick={onClick} data-variant={variant}>
      {children}
    </button>
  ),
}));

vi.mock("~/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-menu">{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
    render,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    render?: React.ReactElement;
  }) => {
    if (render) {
      return <div data-testid="dropdown-item">{render}</div>;
    }
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: test mock
      <div data-testid="dropdown-item" onClick={onClick}>
        {children}
      </div>
    );
  },
  DropdownMenuTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode;
    render?: React.ReactElement;
  }) => {
    if (render) {
      return <div data-testid="dropdown-trigger">{render}</div>;
    }
    return <div data-testid="dropdown-trigger">{children}</div>;
  },
}));

vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip">{children}</div>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode;
    render?: React.ReactElement;
  }) => {
    if (render) {
      return <div data-testid="tooltip-trigger">{render}</div>;
    }
    return <div data-testid="tooltip-trigger">{children}</div>;
  },
}));

vi.mock("~/entities/entities", () => ({
  entities: {
    product: { routes: { detail: "/products/$id" } },
    ingredient: { routes: { detail: "/ingredients/$id" } },
    location: { routes: { detail: "/locations/$id" } },
    recipe: { routes: { detail: "/recipes/$id" } },
    inventory: { routes: { detail: "/inventory/$id" } },
  },
}));

vi.mock("~/lib/utils", () => ({
  cn: (...classes: string[]) => classes.filter(Boolean).join(" "),
  formatCurrency: (val: number) => `$${val.toFixed(2)}`,
}));

vi.mock("../EntityInlineLink", () => ({
  EntityInlineLink: ({
    entity,
    data,
    compact,
  }: {
    entity: string;
    data: { id: string; name: string };
    compact?: boolean;
  }) => (
    <span
      data-testid="entity-inline-link"
      data-entity={entity}
      data-compact={compact}
    >
      {data.name}
    </span>
  ),
}));

vi.mock("../EntityInlineLinkList", () => ({
  EntityInlineLinkList: ({
    entity,
    items,
    maxItems,
    compact,
  }: {
    entity: string;
    items: { id: string; name: string }[];
    maxItems?: number;
    compact?: boolean;
  }) => (
    <div
      data-testid="entity-inline-link-list"
      data-entity={entity}
      data-max={maxItems}
      data-compact={compact}
    >
      {items.map((item) => (
        <span key={item.id}>{item.name}</span>
      ))}
    </div>
  ),
}));

vi.mock("../HoverableTimestamp", () => ({
  HoverableTimestamp: ({ timestamp }: { timestamp: string | Date }) => (
    <span data-testid="hoverable-timestamp">{String(timestamp)}</span>
  ),
}));

vi.mock("../inventory/format-amount", () => ({
  tryFormatAmount: (amount: { value: number; unit: string }) =>
    `${amount.value} ${amount.unit}`,
}));

vi.mock("~/components/ui/none-value", () => ({
  NoneValue: () => <span data-testid="none-value">-</span>,
}));

vi.mock("../TruncatedList", () => ({
  TruncatedList: ({
    items,
    renderItem,
  }: {
    items: unknown[];
    maxItems?: number;
    gap?: string;
    renderItem: (item: unknown) => React.ReactNode;
  }) => <div data-testid="truncated-list">{items.map(renderItem)}</div>,
}));

vi.mock("../table/ImageThumbnail", () => ({
  ImageThumbnail: ({
    images,
    alt,
  }: {
    images: { url: string }[];
    alt: string;
  }) => (
    <img
      data-testid="image-thumbnail"
      src={images[0]?.url || ""}
      alt={alt}
      data-count={images.length}
    />
  ),
}));

vi.mock("../table/TableLink", () => ({
  TableLink: ({
    children,
    to,
    params,
    variant,
  }: {
    children: React.ReactNode;
    to: string;
    params?: object;
    variant?: string;
  }) => (
    <a href={to} data-params={JSON.stringify(params)} data-variant={variant}>
      {children}
    </a>
  ),
}));

vi.mock("../units/UnitMappingDisplay", () => ({
  UnitMappingDisplay: ({
    mappings,
    title,
    compact,
  }: {
    mappings: unknown[];
    title: string;
    compact?: boolean;
  }) => (
    <div data-testid="unit-mapping-display" data-compact={compact}>
      {title} ({mappings.length} mappings)
    </div>
  ),
}));

vi.mock("./editable-cell", () => ({
  EditableCell: ({
    value,
    renderValue,
    config,
  }: {
    value: unknown;
    onSave: (val: unknown) => Promise<void>;
    config: { type: string };
    renderValue: (v: unknown) => React.ReactNode;
  }) => (
    <div data-testid="editable-cell" data-type={config.type}>
      {renderValue(value)}
    </div>
  ),
}));

vi.mock("~/components/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/layout")>()),
  Stack: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stack">{children}</div>
  ),
}));

// Now import the functions under test
import {
  createCreatedAtColumn,
  createCurrencyColumn,
  createEntityInlineLinkColumn,
  createExternalLinkColumn,
  createImageColumn,
  createInventoryEntriesColumn,
  createNameColumn,
  createSingleEntityInlineLinkColumn,
  createTextColumn,
  createTimestampColumn,
  createUnitMappingsColumn,
} from "./columnHelpers";

// Test types
interface TestRow extends Record<string, unknown> {
  id: string;
  name: string;
  manufacturer?: string | null;
  price?: number | null;
  upc?: string | null;
  createdAt?: string | Date;
  images?: { id: string; url: string; filename: string }[];
}

interface InventoryEntryRow extends Record<string, unknown> {
  id: string;
  name: string;
  inventoryEntry?: Array<{
    id: string;
    amount: { value: number; unit: string };
    location?: { id: string; name: string; type: "room" };
  }>;
}

// Helper to render a cell
// biome-ignore lint/suspicious/noExplicitAny: test helper
function renderCell<T>(column: any, row: T): ReturnType<typeof render> {
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  const cellFn = (column as any).cell;
  if (!cellFn) {
    throw new Error("Column has no cell function");
  }
  // Create a minimal CellContext
  const info = {
    getValue: () => {
      // biome-ignore lint/suspicious/noExplicitAny: test helper
      const accessor = (column as any).accessorFn;
      return accessor ? accessor(row) : undefined;
    },
    row: { original: row },
  };
  const cell = cellFn(info);
  return render(cell);
}

describe("createNameColumn", () => {
  const columnHelper = createColumnHelper<TestRow>();

  it("creates a column with correct id", () => {
    const column = createNameColumn(columnHelper, "product");
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((column as any).id).toBe("name");
  });

  it("renders name as link with tooltip", () => {
    const column = createNameColumn(columnHelper, "product");
    const row: TestRow = { id: "123", name: "Test Product" };

    renderCell(column, row);

    expect(screen.getByTestId("tooltip")).toBeInTheDocument();
    expect(screen.getByText("Test Product")).toBeInTheDocument();
  });

  it("renders editable cell when editable option provided", () => {
    const column = createNameColumn(columnHelper, "product", "name", {
      editable: {
        onSave: vi.fn().mockResolvedValue(undefined),
      },
    });
    const row: TestRow = { id: "123", name: "Test Product" };

    renderCell(column, row);

    expect(screen.getByTestId("editable-cell")).toBeInTheDocument();
  });

  it("uses custom field name when specified", () => {
    interface FileRow {
      id: string;
      filename: string;
    }
    const fileColumnHelper = createColumnHelper<FileRow>();
    const column = createNameColumn(fileColumnHelper, "product", "filename");

    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((column as any).id).toBe("filename");
  });
});

describe("createCreatedAtColumn", () => {
  const columnHelper = createColumnHelper<TestRow>();

  it("creates a column with id 'createdAt'", () => {
    const column = createCreatedAtColumn(columnHelper);
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((column as any).id).toBe("createdAt");
  });

  it("renders timestamp when value exists", () => {
    const column = createCreatedAtColumn(columnHelper);
    const row: TestRow = { id: "1", name: "Test", createdAt: "2024-01-15" };

    renderCell(column, row);

    expect(screen.getByTestId("hoverable-timestamp")).toBeInTheDocument();
    expect(screen.getByText("2024-01-15")).toBeInTheDocument();
  });

  it("renders NoneValue when no timestamp", () => {
    const column = createCreatedAtColumn(columnHelper);
    const row: TestRow = { id: "1", name: "Test" };

    renderCell(column, row);

    expect(screen.getByTestId("none-value")).toBeInTheDocument();
  });
});

describe("createImageColumn", () => {
  const columnHelper = createColumnHelper<TestRow>();

  it("creates a column with id 'image'", () => {
    const column = createImageColumn(columnHelper, { entity: "product" });
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((column as any).id).toBe("image");
  });

  it("renders image thumbnail when images exist", () => {
    const column = createImageColumn(columnHelper, { entity: "product" });
    const row: TestRow = {
      id: "1",
      name: "Test",
      images: [
        { id: "img1", url: "https://example.com/img.jpg", filename: "" },
      ],
    };

    renderCell(column, row);

    const thumbnail = screen.getByTestId("image-thumbnail");
    expect(thumbnail).toBeInTheDocument();
    expect(thumbnail).toHaveAttribute("data-count", "1");
  });

  it("uses custom getImages when provided", () => {
    interface CustomRow {
      id: string;
      photos: { id: string; url: string }[];
    }
    const customHelper = createColumnHelper<CustomRow>();
    const column = createImageColumn(customHelper, {
      entity: "product",
      getImages: (row) => row.photos,
    });

    const row: CustomRow = {
      id: "1",
      photos: [
        { id: "p1", url: "https://example.com/p1.jpg" },
        { id: "p2", url: "https://example.com/p2.jpg" },
      ],
    };

    renderCell(column, row);

    const thumbnail = screen.getByTestId("image-thumbnail");
    expect(thumbnail).toHaveAttribute("data-count", "2");
  });
});

describe("createEntityInlineLinkColumn", () => {
  interface RowWithLocations extends Record<string, unknown> {
    id: string;
    locations: { id: string; name: string }[];
  }
  const columnHelper = createColumnHelper<RowWithLocations>();

  it("creates column with correct id", () => {
    const column = createEntityInlineLinkColumn(
      columnHelper,
      "locations",
      "location",
    );
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((column as any).id).toBe("locations");
  });

  it("renders entity inline link list", () => {
    const column = createEntityInlineLinkColumn(
      columnHelper,
      "locations",
      "location",
    );
    const row: RowWithLocations = {
      id: "1",
      locations: [
        { id: "loc1", name: "Kitchen" },
        { id: "loc2", name: "Pantry" },
      ],
    };

    renderCell(column, row);

    expect(screen.getByTestId("entity-inline-link-list")).toBeInTheDocument();
    expect(screen.getByText("Kitchen")).toBeInTheDocument();
    expect(screen.getByText("Pantry")).toBeInTheDocument();
  });

  it("dedupes items when option is set", () => {
    const column = createEntityInlineLinkColumn(
      columnHelper,
      "locations",
      "location",
      {
        dedupe: true,
      },
    );
    const row: RowWithLocations = {
      id: "1",
      locations: [
        { id: "loc1", name: "Kitchen" },
        { id: "loc1", name: "Kitchen" }, // Duplicate
      ],
    };

    renderCell(column, row);

    const pills = screen.getAllByText("Kitchen");
    expect(pills).toHaveLength(1);
  });
});

describe("createUnitMappingsColumn", () => {
  const columnHelper = createColumnHelper<{ id: string }>();

  it("creates column with default id 'unitMappings'", () => {
    const column = createUnitMappingsColumn(columnHelper, {});
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((column as any).id).toBe("unitMappings");
  });

  it("renders unit mapping display", () => {
    const mappingsMap = {
      prod1: [
        {
          a: { value: 1, unit: "cup" },
          b: { value: 240, unit: "g" },
          source: null,
          sourceMetadata: { type: "manual" as const },
        },
      ],
    };
    const column = createUnitMappingsColumn(columnHelper, mappingsMap);
    const row = { id: "prod1" };

    renderCell(column, row);

    const display = screen.getByTestId("unit-mapping-display");
    expect(display).toBeInTheDocument();
    expect(display).toHaveAttribute("data-compact", "true");
  });

  it("uses custom id when provided", () => {
    const column = createUnitMappingsColumn(
      columnHelper,
      {},
      { id: "customMappings" },
    );
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((column as any).id).toBe("customMappings");
  });
});

describe("createInventoryEntriesColumn", () => {
  const columnHelper = createColumnHelper<InventoryEntryRow>();

  it("creates column with correct id", () => {
    const column = createInventoryEntriesColumn(
      columnHelper,
      "inventoryEntry",
      "location",
      (e) => e.location,
    );
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((column as any).id).toBe("inventoryEntry");
  });

  it("renders NoneValue for empty entries", () => {
    const column = createInventoryEntriesColumn(
      columnHelper,
      "inventoryEntry",
      "location",
      (e) => e.location,
    );
    const row: InventoryEntryRow = {
      id: "1",
      name: "Test",
      inventoryEntry: [],
    };

    renderCell(column, row);

    expect(screen.getByTestId("none-value")).toBeInTheDocument();
  });

  it("renders entries with inline layout by default", () => {
    const column = createInventoryEntriesColumn(
      columnHelper,
      "inventoryEntry",
      "location",
      (e) => e.location,
    );
    const row: InventoryEntryRow = {
      id: "1",
      name: "Test",
      inventoryEntry: [
        {
          id: "inv1",
          amount: { value: 5, unit: "lbs" },
          location: { id: "loc1", name: "Kitchen", type: "room" },
        },
      ],
    };

    renderCell(column, row);

    expect(screen.getByTestId("truncated-list")).toBeInTheDocument();
    expect(screen.getByText("5 lbs")).toBeInTheDocument();
  });
});

describe("createTextColumn", () => {
  const columnHelper = createColumnHelper<TestRow>();

  it("creates column with correct id", () => {
    const column = createTextColumn(columnHelper, "manufacturer");
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((column as any).id).toBe("manufacturer");
  });

  it("renders text value", () => {
    const column = createTextColumn(columnHelper, "manufacturer");
    const row: TestRow = { id: "1", name: "Test", manufacturer: "Acme Corp" };

    renderCell(column, row);

    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
  });

  it("renders NoneValue for null value", () => {
    const column = createTextColumn(columnHelper, "manufacturer");
    const row: TestRow = { id: "1", name: "Test", manufacturer: null };

    renderCell(column, row);

    expect(screen.getByTestId("none-value")).toBeInTheDocument();
  });

  it("renders editable cell when editable option provided", () => {
    const column = createTextColumn(columnHelper, "manufacturer", {
      editable: {
        onSave: vi.fn().mockResolvedValue(undefined),
      },
    });
    const row: TestRow = { id: "1", name: "Test", manufacturer: "Acme" };

    renderCell(column, row);

    expect(screen.getByTestId("editable-cell")).toBeInTheDocument();
    expect(screen.getByTestId("editable-cell")).toHaveAttribute(
      "data-type",
      "text",
    );
  });
});

describe("createCurrencyColumn", () => {
  const columnHelper = createColumnHelper<TestRow>();

  it("creates column with correct id", () => {
    const column = createCurrencyColumn(columnHelper, "price");
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((column as any).id).toBe("price");
  });

  it("renders formatted currency", () => {
    const column = createCurrencyColumn(columnHelper, "price");
    const row: TestRow = { id: "1", name: "Test", price: 9.99 };

    renderCell(column, row);

    expect(screen.getByText("$9.99")).toBeInTheDocument();
  });

  it("renders NoneValue for null price", () => {
    const column = createCurrencyColumn(columnHelper, "price");
    const row: TestRow = { id: "1", name: "Test", price: null };

    renderCell(column, row);

    expect(screen.getByTestId("none-value")).toBeInTheDocument();
  });

  it("renders editable cell when editable option provided", () => {
    const column = createCurrencyColumn(columnHelper, "price", {
      editable: {
        onSave: vi.fn().mockResolvedValue(undefined),
      },
    });
    const row: TestRow = { id: "1", name: "Test", price: 5.0 };

    renderCell(column, row);

    expect(screen.getByTestId("editable-cell")).toBeInTheDocument();
    expect(screen.getByTestId("editable-cell")).toHaveAttribute(
      "data-type",
      "currency",
    );
  });
});

describe("createSingleEntityInlineLinkColumn", () => {
  interface RowWithIngredient extends Record<string, unknown> {
    id: string;
    ingredient: { id: string; name: string } | null;
  }
  const columnHelper = createColumnHelper<RowWithIngredient>();

  it("creates column with correct id", () => {
    const column = createSingleEntityInlineLinkColumn(
      columnHelper,
      "ingredient",
      "ingredient",
    );
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((column as any).id).toBe("ingredient");
  });

  it("renders entity inline link when data exists", () => {
    const column = createSingleEntityInlineLinkColumn(
      columnHelper,
      "ingredient",
      "ingredient",
    );
    const row: RowWithIngredient = {
      id: "1",
      ingredient: { id: "ing1", name: "Flour" },
    };

    renderCell(column, row);

    expect(screen.getByTestId("entity-inline-link")).toBeInTheDocument();
    expect(screen.getByText("Flour")).toBeInTheDocument();
  });

  it("renders NoneValue when data is null", () => {
    const column = createSingleEntityInlineLinkColumn(
      columnHelper,
      "ingredient",
      "ingredient",
    );
    const row: RowWithIngredient = { id: "1", ingredient: null };

    renderCell(column, row);

    expect(screen.getByTestId("none-value")).toBeInTheDocument();
  });
});

describe("createExternalLinkColumn", () => {
  const columnHelper = createColumnHelper<TestRow>();

  it("creates column with correct id", () => {
    const column = createExternalLinkColumn(
      columnHelper,
      "upc",
      "/usda/upc/$code",
    );
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((column as any).id).toBe("upc");
  });

  it("renders link with value", () => {
    const column = createExternalLinkColumn(
      columnHelper,
      "upc",
      "/usda/upc/$code",
    );
    const row: TestRow = { id: "1", name: "Test", upc: "123456789012" };

    renderCell(column, row);

    const link = screen.getByText("123456789012");
    expect(link).toBeInTheDocument();
    expect(link.closest("a")).toHaveAttribute("href", "/usda/upc/$code");
  });

  it("renders NoneValue for null value", () => {
    const column = createExternalLinkColumn(
      columnHelper,
      "upc",
      "/usda/upc/$code",
    );
    const row: TestRow = { id: "1", name: "Test", upc: null };

    renderCell(column, row);

    expect(screen.getByTestId("none-value")).toBeInTheDocument();
  });

  it("renders editable cell when editable option provided", () => {
    const column = createExternalLinkColumn(
      columnHelper,
      "upc",
      "/usda/upc/$code",
      {
        editable: {
          onSave: vi.fn().mockResolvedValue(undefined),
        },
      },
    );
    const row: TestRow = { id: "1", name: "Test", upc: "123" };

    renderCell(column, row);

    expect(screen.getByTestId("editable-cell")).toBeInTheDocument();
  });
});

describe("createTimestampColumn", () => {
  interface RowWithTimestamp extends Record<string, unknown> {
    id: string;
    lastUpdated: string | Date | null;
  }
  const columnHelper = createColumnHelper<RowWithTimestamp>();

  it("creates column with correct id", () => {
    const column = createTimestampColumn(columnHelper, "lastUpdated");
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((column as any).id).toBe("lastUpdated");
  });

  it("renders timestamp when value exists", () => {
    const column = createTimestampColumn(columnHelper, "lastUpdated");
    const row: RowWithTimestamp = { id: "1", lastUpdated: "2024-01-15" };

    renderCell(column, row);

    expect(screen.getByTestId("hoverable-timestamp")).toBeInTheDocument();
  });

  it("renders NoneValue when value is null", () => {
    const column = createTimestampColumn(columnHelper, "lastUpdated");
    const row: RowWithTimestamp = { id: "1", lastUpdated: null };

    renderCell(column, row);

    expect(screen.getByTestId("none-value")).toBeInTheDocument();
  });

  it("renders custom fallback when provided", () => {
    const column = createTimestampColumn(columnHelper, "lastUpdated", {
      fallback: <span data-testid="custom-fallback">Never</span>,
    });
    const row: RowWithTimestamp = { id: "1", lastUpdated: null };

    renderCell(column, row);

    expect(screen.getByTestId("custom-fallback")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
  });
});
