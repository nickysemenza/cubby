import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Test the pure functions by importing them indirectly through component behavior
// Since the functions are not exported, we test them through the components that use them

// Mock dependencies
vi.mock("@tanstack/react-query", () => ({
  useMutation: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useQueryClient: vi.fn(() => ({
    invalidateQueries: vi.fn(),
  })),
}));

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
    <a href={`${to}/${params && "id" in params ? params.id : ""}`}>
      {children}
    </a>
  ),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("~/trpc/react", () => ({
  useTRPC: () => ({
    googleSheets: {
      applySync: {
        mutationOptions: vi.fn(() => ({})),
      },
    },
  }),
}));

vi.mock("~/components/ui/combobox", () => ({
  FilterableCombobox: ({
    value,
    onValueChange,
    placeholder,
    items,
  }: {
    value: string | null;
    onValueChange: (v: string | null) => void;
    placeholder: string;
    items: { value: string; label: string }[];
  }) => (
    <select
      value={value ?? ""}
      onChange={(e) => onValueChange(e.target.value || null)}
      data-testid="resolution-select"
    >
      <option value="">{placeholder}</option>
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h1>{children}</h1>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-footer">{children}</div>
  ),
}));

vi.mock("~/components/ui/alert-dialog", () => ({
  AlertDialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open: boolean;
  }) => (open ? <div data-testid="alert-dialog">{children}</div> : null),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

vi.mock("~/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant,
    title,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    title?: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-variant={variant}
      title={title}
    >
      {children}
    </button>
  ),
}));

vi.mock("~/components/ui/spinner", () => ({
  Spinner: () => <span data-testid="spinner">Loading...</span>,
}));

vi.mock("~/components/common/colored-alert", () => ({
  ColoredAlert: ({
    children,
    variant,
  }: {
    children: React.ReactNode;
    variant: string;
  }) => <div data-testid={`alert-${variant}`}>{children}</div>,
}));

vi.mock("../NoneState", () => ({
  NoneState: () => <span data-testid="none-state">-</span>,
}));

vi.mock("../value-change", () => ({
  ValueChange: ({
    label,
    from,
    to,
  }: {
    label: string;
    from: unknown;
    to: unknown;
  }) => (
    <span data-testid="value-change">
      {label}: {String(from)} → {String(to)}
    </span>
  ),
}));

import type { SyncPreviewResult } from "~/schemas/sync";
import { SyncDialog } from "./sync-dialog";

const createMockPreviewResult = (
  overrides: Partial<SyncPreviewResult> = {},
): SyncPreviewResult => ({
  locations: {
    items: [],
    matched: 0,
    conflicts: 0,
    appOnly: 0,
    sheetOnly: 0,
    renamed: 0,
  },
  inventory: {
    items: [],
    matched: 0,
    conflicts: 0,
    appOnly: 0,
    sheetOnly: 0,
    renamed: 0,
    moved: 0,
  },
  validationErrors: [],
  ...overrides,
});

describe("SyncDialog", () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    previewResult: createMockPreviewResult(),
    onClose: vi.fn(),
    onSyncComplete: vi.fn(),
  };

  it("renders loading state when no preview result", () => {
    render(<SyncDialog {...defaultProps} previewResult={null} />);

    expect(screen.getByText("Loading Sync Preview...")).toBeInTheDocument();
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
  });

  it("renders sync preview title when preview available", () => {
    render(<SyncDialog {...defaultProps} />);

    expect(screen.getByText("Sync Preview")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Review and resolve differences between app and Google Sheet.",
      ),
    ).toBeInTheDocument();
  });

  it("shows 'Everything is in sync' when no items", () => {
    render(<SyncDialog {...defaultProps} />);

    expect(
      screen.getByText("Everything is in sync! No differences found."),
    ).toBeInTheDocument();
  });

  it("renders location items when present", () => {
    const previewResult = createMockPreviewResult({
      locations: {
        items: [
          {
            key: "loc-1",
            state: "app_only",
            appData: { locationId: "1", locationName: "Kitchen" },
          },
        ],
        matched: 0,
        conflicts: 0,
        appOnly: 1,
        sheetOnly: 0,
        renamed: 0,
      },
    });

    render(<SyncDialog {...defaultProps} previewResult={previewResult} />);

    expect(screen.getByText("Locations")).toBeInTheDocument();
    expect(screen.getByText("Kitchen")).toBeInTheDocument();
  });

  it("renders inventory items when present", () => {
    const previewResult = createMockPreviewResult({
      inventory: {
        items: [
          {
            key: "inv-1",
            state: "sheet_only",
            sheetData: {
              productName: "Flour",
              locationName: "Pantry",
              quantity: 5,
              unit: "lbs",
            },
          },
        ],
        matched: 0,
        conflicts: 0,
        appOnly: 0,
        sheetOnly: 1,
        renamed: 0,
        moved: 0,
      },
    });

    render(<SyncDialog {...defaultProps} previewResult={previewResult} />);

    expect(screen.getByText("Inventory")).toBeInTheDocument();
    expect(screen.getByText("Flour")).toBeInTheDocument();
  });

  it("shows validation errors when present", () => {
    const previewResult = createMockPreviewResult({
      validationErrors: [
        {
          entityType: "location",
          itemKey: "loc-1",
          message: "Invalid location name",
        },
      ],
    });

    render(<SyncDialog {...defaultProps} previewResult={previewResult} />);

    expect(screen.getByTestId("alert-destructive")).toBeInTheDocument();
    expect(screen.getByText("Invalid location name")).toBeInTheDocument();
  });

  it("disables apply button when conflicts unresolved", () => {
    const previewResult = createMockPreviewResult({
      locations: {
        items: [
          {
            key: "loc-1",
            state: "conflict",
            appData: { locationId: "1", locationName: "Kitchen" },
            sheetData: { locationName: "Kitchen Updated" },
            fieldDiffs: [
              { field: "name", from: "Kitchen", to: "Kitchen Updated" },
            ],
          },
        ],
        matched: 0,
        conflicts: 1,
        appOnly: 0,
        sheetOnly: 0,
        renamed: 0,
      },
    });

    render(<SyncDialog {...defaultProps} previewResult={previewResult} />);

    const applyButton = screen.getByText("Apply Sync");
    expect(applyButton).toBeDisabled();
  });

  it("shows cancel and apply buttons in footer", () => {
    render(<SyncDialog {...defaultProps} />);

    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.getByText("Apply Sync")).toBeInTheDocument();
    expect(screen.getByText("Refresh Timestamps")).toBeInTheDocument();
  });

  it("calls onClose when cancel clicked", () => {
    const onClose = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <SyncDialog
        {...defaultProps}
        onClose={onClose}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(screen.getByText("Cancel"));

    expect(onClose).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not render when open is false", () => {
    render(<SyncDialog {...defaultProps} open={false} />);

    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument();
  });
});

describe("SyncDialog state summary cards", () => {
  it("renders state summary cards for locations", () => {
    const previewResult = createMockPreviewResult({
      locations: {
        items: [
          {
            key: "loc-1",
            state: "matched",
            appData: { locationId: "1", locationName: "Kitchen" },
          },
          {
            key: "loc-2",
            state: "conflict",
            appData: { locationId: "2", locationName: "Pantry" },
            sheetData: { locationName: "Pantry Updated" },
            fieldDiffs: [
              { field: "name", from: "Pantry", to: "Pantry Updated" },
            ],
          },
        ],
        matched: 1,
        conflicts: 1,
        appOnly: 0,
        sheetOnly: 0,
        renamed: 0,
      },
    });

    render(
      <SyncDialog
        open={true}
        onOpenChange={vi.fn()}
        previewResult={previewResult}
        onClose={vi.fn()}
        onSyncComplete={vi.fn()}
      />,
    );

    // Should see counts in state cards (use getAllByText since labels appear in both card and badge)
    const matchedElements = screen.getAllByText("Matched");
    expect(matchedElements.length).toBeGreaterThan(0);
    const conflictElements = screen.getAllByText("Conflict");
    expect(conflictElements.length).toBeGreaterThan(0);
  });

  it("toggles state visibility when card clicked", () => {
    const previewResult = createMockPreviewResult({
      locations: {
        items: [
          {
            key: "loc-1",
            state: "matched",
            appData: { locationId: "1", locationName: "Kitchen" },
          },
        ],
        matched: 1,
        conflicts: 0,
        appOnly: 0,
        sheetOnly: 0,
        renamed: 0,
      },
    });

    render(
      <SyncDialog
        open={true}
        onOpenChange={vi.fn()}
        previewResult={previewResult}
        onClose={vi.fn()}
        onSyncComplete={vi.fn()}
      />,
    );

    // Matched items are hidden by default
    expect(screen.queryByText("Kitchen")).not.toBeInTheDocument();

    // Click the Matched card to show items
    fireEvent.click(screen.getByText("Matched"));

    // Now Kitchen should be visible
    expect(screen.getByText("Kitchen")).toBeInTheDocument();
  });
});

describe("SyncDialog conflict resolution", () => {
  it("shows resolution dropdown for conflicts", () => {
    const previewResult = createMockPreviewResult({
      locations: {
        items: [
          {
            key: "loc-1",
            state: "conflict",
            appData: { locationId: "1", locationName: "Kitchen" },
            sheetData: { locationName: "Kitchen Updated" },
            fieldDiffs: [
              { field: "name", from: "Kitchen", to: "Kitchen Updated" },
            ],
          },
        ],
        matched: 0,
        conflicts: 1,
        appOnly: 0,
        sheetOnly: 0,
        renamed: 0,
      },
    });

    render(
      <SyncDialog
        open={true}
        onOpenChange={vi.fn()}
        previewResult={previewResult}
        onClose={vi.fn()}
        onSyncComplete={vi.fn()}
      />,
    );

    // Should have a resolution dropdown
    const select = screen.getByTestId("resolution-select");
    expect(select).toBeInTheDocument();
  });

  it("enables apply button when all conflicts resolved", () => {
    const previewResult = createMockPreviewResult({
      locations: {
        items: [
          {
            key: "loc-1",
            state: "conflict",
            resolution: "use_app", // Pre-resolved
            appData: { locationId: "1", locationName: "Kitchen" },
            sheetData: { locationName: "Kitchen Updated" },
            fieldDiffs: [
              { field: "name", from: "Kitchen", to: "Kitchen Updated" },
            ],
          },
        ],
        matched: 0,
        conflicts: 1,
        appOnly: 0,
        sheetOnly: 0,
        renamed: 0,
      },
    });

    render(
      <SyncDialog
        open={true}
        onOpenChange={vi.fn()}
        previewResult={previewResult}
        onClose={vi.fn()}
        onSyncComplete={vi.fn()}
      />,
    );

    const applyButton = screen.getByText("Apply Sync");
    expect(applyButton).not.toBeDisabled();
  });
});

describe("SyncDialog moved items", () => {
  it("renders moved items with from/to locations", () => {
    const previewResult = createMockPreviewResult({
      inventory: {
        items: [
          {
            key: "inv-1",
            state: "moved",
            movedFrom: "Kitchen",
            movedTo: "Pantry",
            appData: {
              productId: "p1",
              productName: "Flour",
              locationId: "l1",
              locationName: "Kitchen",
            },
            sheetData: {
              productName: "Flour",
              locationName: "Pantry",
              quantity: 5,
              unit: "lbs",
            },
          },
        ],
        matched: 0,
        conflicts: 0,
        appOnly: 0,
        sheetOnly: 0,
        renamed: 0,
        moved: 1,
      },
    });

    render(
      <SyncDialog
        open={true}
        onOpenChange={vi.fn()}
        previewResult={previewResult}
        onClose={vi.fn()}
        onSyncComplete={vi.fn()}
      />,
    );

    // "Moved" appears in both summary card and badge
    const movedElements = screen.getAllByText("Moved");
    expect(movedElements.length).toBeGreaterThan(0);
    expect(screen.getByText("Flour")).toBeInTheDocument();
    // The moved from/to locations are shown (Kitchen crossed out, Pantry as new)
    const kitchenElements = screen.getAllByText("Kitchen");
    expect(kitchenElements.length).toBeGreaterThan(0);
    const pantryElements = screen.getAllByText("Pantry");
    expect(pantryElements.length).toBeGreaterThan(0);
  });
});
