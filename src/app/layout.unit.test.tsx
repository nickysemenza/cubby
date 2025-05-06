import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RootLayout from "./layout";

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

describe("App Router: Works with Client Components", () => {
  vi.mock("geist/font/sans", () => {
    return {
      GeistSans: {
        variable: "foo",
      },
    };
  });
  vi.mock("next/navigation", () => {
    return {
      usePathname: () => "/recipes",
      useRouter: () => ({
        push: vi.fn(),
      }),
    };
  });

  it("renders the main nav", () => {
    render(<RootLayout>hello</RootLayout>);
    // expect it to render recipes
    expect(screen.getByText("Recipes")).toBeTruthy();
    expect(screen.getByText("Ingredients")).toBeTruthy();
  });
});
