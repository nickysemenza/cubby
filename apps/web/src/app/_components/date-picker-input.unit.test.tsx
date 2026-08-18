import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useId, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DatePickerInput } from "./date-picker-input";

vi.mock("~/components/ui/calendar", () => ({
  Calendar: ({
    onSelect,
    required,
  }: {
    onSelect: (day: Date | undefined) => void;
    required?: boolean;
  }) => (
    <>
      <button type="button" onClick={() => onSelect(new Date(2026, 7, 20))}>
        Thursday, August 20th, 2026
      </button>
      <button type="button" onClick={() => onSelect(undefined)}>
        Reselect selected day
      </button>
      <output data-testid="calendar-required">{String(required)}</output>
    </>
  ),
}));

function ControlledPicker({ initial = null }: { initial?: string | null }) {
  const [value, setValue] = useState(initial);
  return (
    <DatePickerInput
      value={value}
      onChange={setValue}
      clearable
      aria-label="Due date"
    />
  );
}

function ExternallyLabeledPicker() {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>Due date</label>
      <DatePickerInput id={id} value={null} onChange={vi.fn()} />
    </>
  );
}

describe("DatePickerInput", () => {
  it("renders an editable, labeled field without opening the calendar on focus", () => {
    render(<ControlledPicker initial="2026-08-18" />);

    const input = screen.getByRole("textbox", { name: "Due date" });
    expect(input).toHaveValue("Aug 18, 2026");
    fireEvent.focus(input);
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open calendar" }),
    ).toBeInTheDocument();
  });

  it("uses an associated external label instead of overriding it with the placeholder", () => {
    render(<ExternallyLabeledPicker />);

    expect(
      screen.getByRole("textbox", { name: "Due date" }),
    ).toBeInTheDocument();
  });

  it("commits typed and pasted expressions as canonical dates on Enter", () => {
    const onChange = vi.fn();
    render(
      <DatePickerInput
        value={null}
        onChange={onChange}
        aria-label="Due date"
      />,
    );

    const input = screen.getByRole("textbox", { name: "Due date" });
    fireEvent.change(input, { target: { value: "Aug 18, 2026" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("2026-08-18");
    expect(input).toHaveValue("Aug 18, 2026");
  });

  it("commits when focus leaves the composite field", () => {
    const onChange = vi.fn();
    render(
      <div>
        <DatePickerInput
          value={null}
          onChange={onChange}
          aria-label="Due date"
        />
        <button type="button">Outside</button>
      </div>,
    );

    const input = screen.getByRole("textbox", { name: "Due date" });
    fireEvent.change(input, { target: { value: "8/18/2026" } });
    input.focus();
    screen.getByRole("button", { name: "Outside" }).focus();

    expect(onChange).toHaveBeenCalledWith("2026-08-18");
  });

  it("preserves invalid text, announces the error, and blocks form submission", async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <DatePickerInput
          value="2026-08-18"
          onChange={onChange}
          aria-label="Due date"
        />
        <button type="submit">Save</button>
      </form>,
    );

    const input = screen.getByRole("textbox", { name: "Due date" });
    fireEvent.change(input, { target: { value: "February 30, 2026" } });
    input.focus();
    screen.getByRole("button", { name: "Save" }).focus();

    expect(input).toHaveValue("February 30, 2026");
    expect(input).toBeInvalid();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Couldn’t understand that date",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("enforces required and inclusive plain-date bounds", () => {
    const onChange = vi.fn();
    const view = render(
      <DatePickerInput
        value={null}
        onChange={onChange}
        aria-label="Due date"
        required
        min="2026-08-10"
        max="2026-08-20"
      />,
    );

    const input = screen.getByRole("textbox", { name: "Due date" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a date.");

    fireEvent.change(input, { target: { value: "Aug 9, 2026" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a date on or after Aug 10, 2026.",
    );

    view.rerender(
      <DatePickerInput
        value={null}
        onChange={onChange}
        aria-label="Due date"
        required
        min="2026-08-10"
        max="2026-08-20"
      />,
    );
    fireEvent.change(input, { target: { value: "Aug 21, 2026" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a date on or before Aug 20, 2026.",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("restores the committed value and clears validity on Escape", () => {
    render(<ControlledPicker initial="2026-08-18" />);
    const input = screen.getByRole("textbox", { name: "Due date" });

    fireEvent.change(input, { target: { value: "not a date" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toBeInvalid();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("Aug 18, 2026");
    expect(input).toBeValid();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("syncs when the controlled value changes", () => {
    const onChange = vi.fn();
    const view = render(
      <DatePickerInput
        value="2026-08-18"
        onChange={onChange}
        aria-label="Due date"
      />,
    );

    view.rerender(
      <DatePickerInput
        value="2026-08-20"
        onChange={onChange}
        aria-label="Due date"
      />,
    );
    expect(screen.getByRole("textbox", { name: "Due date" })).toHaveValue(
      "Aug 20, 2026",
    );
  });

  it("clears from the dedicated affordance", () => {
    const onChange = vi.fn();
    render(
      <DatePickerInput
        value="2026-08-18"
        onChange={onChange}
        clearable
        aria-label="Due date"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear date" }));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(screen.getByRole("textbox", { name: "Due date" })).toHaveValue("");
  });

  it("selects a date from the dedicated calendar button", async () => {
    const onChange = vi.fn();
    render(
      <DatePickerInput
        value="2026-08-18"
        onChange={onChange}
        aria-label="Due date"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open calendar" }));
    const day = await screen.findByRole("button", {
      name: /Thursday, August 20th, 2026/i,
    });
    fireEvent.click(day);

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith("2026-08-20");
    });
  });

  it("does not clear a required field when the selected calendar day is reselected", async () => {
    const onChange = vi.fn();
    render(
      <DatePickerInput
        value="2026-08-18"
        onChange={onChange}
        aria-label="Due date"
        required
        clearable
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Clear date" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open calendar" }));
    expect(await screen.findByTestId("calendar-required")).toHaveTextContent(
      "true",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reselect selected day" }),
    );

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Due date" })).toHaveValue(
      "Aug 18, 2026",
    );
  });
});
