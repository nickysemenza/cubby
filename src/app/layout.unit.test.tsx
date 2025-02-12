import { describe, expect, it, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RootLayout from "./layout";
import Home from "./page";

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
    };
  });
  it("renders the main nav", () => {
    render(<RootLayout>hello</RootLayout>);
    // expect it to render recipes
    expect(screen.getByText("recipes")).toBeTruthy();
    expect(screen.getByText("ingredients")).toBeTruthy();
  });
});
