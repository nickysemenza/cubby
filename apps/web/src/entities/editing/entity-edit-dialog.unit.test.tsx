import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  reset: vi.fn(),
  toast: vi.fn(),
  issues: [] as { field?: string; message: string; source: string }[],
}));

vi.mock("sonner", () => ({ toast: { success: mocks.toast } }));
vi.mock("~/components/ui/responsive-dialog", () => ({
  ResponsiveDialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) => (open ? <div>{children}</div> : null),
}));
vi.mock("~/app/_components/form-utils", () => ({
  FormWrapper: ({
    children,
    onSubmit,
    onCancel,
    error,
  }: {
    children: ReactNode;
    onSubmit: () => void;
    onCancel: () => void;
    error?: string | readonly string[];
  }) => (
    <div>
      {children}
      {(typeof error === "string" ? [error] : (error ?? [])).map((line) => (
        <p key={line}>{line}</p>
      ))}
      <button type="button" onClick={onSubmit}>
        submit
      </button>
      <button type="button" onClick={onCancel}>
        cancel
      </button>
    </div>
  ),
}));
vi.mock("./editor-presentations", () => ({
  getEntityEditorPresentation: () => ({
    title: () => "New Meal",
    description: () => "description",
    Fields: () => <div>Meal fields</div>,
    successMessage: () => "Meal created",
  }),
}));
vi.mock("./use-entity-edit-session", () => ({
  useEntityEditSession: () => ({
    form: {},
    issues: mocks.issues,
    isPending: false,
    reset: mocks.reset,
    submit: mocks.submit,
  }),
}));

import { EntityEditDialog } from "./entity-edit-dialog";

describe("EntityEditDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.issues.length = 0;
  });

  it("banners every field-less refusal, not just the first", async () => {
    mocks.issues.push(
      { message: "Meal cannot be saved", source: "server" },
      { field: "name", message: "Required", source: "server" },
      {
        message: "Recipes: 2 recipes still reference this meal.",
        source: "server",
      },
    );

    render(
      <EntityEditDialog
        open
        onOpenChange={vi.fn()}
        request={{ entity: "meal", operation: "create", intent: "capture" }}
      />,
    );

    expect(await screen.findByText("Meal cannot be saved")).toBeInTheDocument();
    expect(
      screen.getByText("Recipes: 2 recipes still reference this meal."),
    ).toBeInTheDocument();
    // Field-scoped issues belong beside their control, not in the banner.
    expect(screen.queryByText("Required")).not.toBeInTheDocument();
  });

  it("retains a failed draft and closes only after a successful write", async () => {
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    mocks.submit
      .mockResolvedValueOnce({
        ok: false,
        issues: [{ message: "Nope", source: "server" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        entity: "meal",
        id: "MEL-TEST",
        changed: true,
        result: { id: "MEL-TEST", name: "Dinner" },
      });

    render(
      <EntityEditDialog
        open
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        request={{
          entity: "meal",
          operation: "create",
          intent: "capture",
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "submit" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mocks.reset).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "submit" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onSuccess).toHaveBeenCalledWith({
      id: "MEL-TEST",
      name: "Dinner",
    });
    expect(mocks.toast).toHaveBeenCalledWith("Meal created");
  });
});
