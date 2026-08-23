import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button phone sizing", () => {
  it("uses the 44px touch floor on phones by default", () => {
    render(<Button>Save</Button>);

    expect(screen.getByRole("button", { name: "Save" })).toHaveClass(
      "max-md:min-h-11",
      "max-md:min-w-11",
    );
  });

  it("permits an explicit compact exception without changing desktop sizing", () => {
    render(
      <Button mobileSize="compact" size="sm">
        Dense control
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Dense control" });
    expect(button).toHaveClass("h-6");
    expect(button).not.toHaveClass("max-md:min-h-11");
  });
});
