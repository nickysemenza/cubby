import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DialogFormActions } from "./dialog-form-actions";

describe("DialogFormActions", () => {
  it("calls onCancel when Cancel is clicked", () => {
    const onCancel = vi.fn();
    render(<DialogFormActions onCancel={onCancel} submitLabel="Save" />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("associates the submit button with a form id for native submission", () => {
    render(
      <DialogFormActions
        onCancel={() => {}}
        submitLabel="Save"
        form="my-form"
      />,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("type", "submit");
    expect(button).toHaveAttribute("form", "my-form");
  });

  it("defaults to a plain submit button when neither form nor onSubmit is given, so nesting inside a real <form> still works", () => {
    render(<DialogFormActions onCancel={() => {}} submitLabel="Save" />);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("type", "submit");
    expect(button).not.toHaveAttribute("form");
  });

  it("calls onSubmit directly when there is no associated form", () => {
    const onSubmit = vi.fn();
    render(
      <DialogFormActions
        onCancel={() => {}}
        submitLabel="Save"
        onSubmit={onSubmit}
      />,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("type", "button");
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("shows the pending state and disables both buttons", () => {
    render(
      <DialogFormActions onCancel={() => {}} submitLabel="Save" pending />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Saving…/ })).toBeDisabled();
  });

  it("disables the submit button when submitDisabled is set", () => {
    render(
      <DialogFormActions onCancel={() => {}} submitLabel="Save" submitDisabled />,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("renders the error as an alert", () => {
    render(
      <DialogFormActions
        onCancel={() => {}}
        submitLabel="Save"
        error="Something went wrong"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
  });

});
