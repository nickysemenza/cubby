import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MainNav } from "./_components/MainNav";
import { DebugContextProvider } from "../hooks/useDebug";

// Mock matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};
Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
});

// Mock OrganizationSwitcher to keep test isolated from auth client
vi.mock("~/components/project/OrganizationSwitcher", () => {
  return {
    OrganizationSwitcher: () => <div />,
  };
});

// Mock SyncStatusBadge to avoid TRPC provider requirement
vi.mock("./_components/sync/sync-status-badge", () => {
  return {
    SyncStatusBadge: () => <div />,
  };
});

// Mock next/navigation
vi.mock("next/navigation", () => {
  return {
    usePathname: () => "/recipes",
    useRouter: () => ({
      push: vi.fn(),
    }),
  };
});

describe("App Router: Works with Client Components", () => {
  it("renders the main nav", () => {
    // Mock the layout to avoid html/body nesting issues in tests
    const LayoutContent = () => (
      <DebugContextProvider>
        <div className="flex flex-col">
          <MainNav />
          <div>hello</div>
        </div>
      </DebugContextProvider>
    );

    render(<LayoutContent />);
    // expect it to render visible nav items (Recipes and Ingredients are in Kitchen dropdown)
    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.getByText("Products")).toBeTruthy();
    expect(screen.getByText("Kitchen")).toBeTruthy(); // Dropdown containing Recipes & Ingredients
    expect(screen.getByText("Locations")).toBeTruthy();
    expect(screen.getByText("Inventory")).toBeTruthy();
  });
});
