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
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};
Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
});

// Mock Clerk components
vi.mock("@clerk/nextjs", () => {
  return {
    ClerkProvider: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    SignInButton: () => <div>Sign In</div>,
    SignedIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SignedOut: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    UserButton: () => <div>User</div>,
  };
});

describe("App Router: Works with Client Components", () => {
  vi.mock("next/navigation", () => {
    return {
      usePathname: () => "/recipes",
      useRouter: () => ({
        push: vi.fn(),
      }),
    };
  });

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
    // expect it to render recipes
    expect(screen.getByText("Recipes")).toBeTruthy();
    expect(screen.getByText("Ingredients")).toBeTruthy();
  });
});
