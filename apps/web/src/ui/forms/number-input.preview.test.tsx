import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { NumberInput } from "./number-input";

it("clears to null, retains partial input, and clamps on blur", async () => {
  const changed = vi.fn();
  function Example() {
    const [value, setValue] = useState<number | null>(4);
    return (
      <>
        <NumberInput
          aria-label="Amount"
          min={-10}
          max={10}
          value={value}
          onValueChange={(next) => {
            changed(next);
            setValue(next);
          }}
        />
        <button>Outside</button>
      </>
    );
  }
  render(<Example />);
  const input = screen.getByRole("textbox", { name: "Amount" });
  await userEvent.clear(input);
  expect(changed).toHaveBeenLastCalledWith(null);
  changed.mockClear();
  await userEvent.type(input, "-");
  expect(input).toHaveValue("-");
  expect(changed).not.toHaveBeenCalled();
  await userEvent.clear(input);
  await userEvent.type(input, "1.");
  expect(input).toHaveValue("1.");
  expect(changed).toHaveBeenLastCalledWith(1);
  await userEvent.clear(input);
  await userEvent.type(input, "-20");
  await userEvent.click(screen.getByRole("button", { name: "Outside" }));
  expect(changed).toHaveBeenLastCalledWith(-10);
  expect(input).toHaveValue("-10");
});
