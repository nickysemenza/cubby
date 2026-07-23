import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChipsInput } from "./chips-input";

describe("ChipsInput Enter handling", () => {
  it("Enter with text adds a chip (normalized); Enter on empty input calls onEmptyEnter", () => {
    const onChange = vi.fn();
    const onEmptyEnter = vi.fn();
    const { getByRole } = render(
      <ChipsInput
        value={["existing"]}
        onChange={onChange}
        normalize={(raw) => raw.trim().toLowerCase()}
        onEmptyEnter={onEmptyEnter}
      />,
    );
    const input = getByRole("textbox");

    // Type → Enter chips it; the input clears rather than committing.
    fireEvent.change(input, { target: { value: "  Quick " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["existing", "quick"]);
    expect(onEmptyEnter).not.toHaveBeenCalled();

    // Enter again on the now-empty input → commit hook fires (type → Enter →
    // Enter flow in the inline cell editor).
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEmptyEnter).toHaveBeenCalledTimes(1);
  });

  it("Enter on empty input is a no-op without onEmptyEnter (recipe form behavior)", () => {
    const onChange = vi.fn();
    const { getByRole } = render(<ChipsInput value={[]} onChange={onChange} />);
    fireEvent.keyDown(getByRole("textbox"), { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
