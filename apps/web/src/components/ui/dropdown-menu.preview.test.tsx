import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSubmenu,
  DropdownMenuSubmenuTrigger,
} from "./dropdown-menu";

describe("dropdown menu touch targets", () => {
  it.each([
    ["phone", 402, 44],
    ["desktop", 1440, 32],
  ] as const)("keeps menu choices at the %s height", async (_label, width, minHeight) => {
    await page.viewport(width, 900);
    render(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuItem>Review item</DropdownMenuItem>
          <DropdownMenuSubmenu>
            <DropdownMenuSubmenuTrigger>Saved views</DropdownMenuSubmenuTrigger>
          </DropdownMenuSubmenu>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    for (const name of ["Review item", "Saved views"]) {
      const item = await screen.findByRole("menuitem", { name });
      expect(item.getBoundingClientRect().height).toBeGreaterThanOrEqual(minHeight);
    }
  });
});
