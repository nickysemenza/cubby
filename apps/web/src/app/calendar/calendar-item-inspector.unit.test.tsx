import type { CalendarItem } from "@cubby/schemas/calendar";
import { unsafeExpenseShortcode } from "@cubby/schemas/identifiers";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import {
  CalendarInspectorBody,
  EditableCalendarItem,
} from "./calendar-item-inspector";
import { calendarItemEditDescriptor } from "./calendar-kind-registry";

const session = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock("~/entities/editing", () => ({
  useEntityEditSession: ({ record }: { record: Record<string, unknown> }) => {
    const form = useForm<Record<string, unknown>>({ defaultValues: record });
    const [issues, setIssues] = useState<
      Array<{ message: string; source: "server" }>
    >([]);
    return {
      form,
      values: form.watch(),
      access: { mode: "editable" as const },
      isPending: false,
      issues,
      set: form.setValue,
      reset: form.reset,
      submit: async () => {
        try {
          await session.save(form.getValues());
          return {
            ok: true as const,
            entity: "expense",
            id: String(record.id),
            changed: true,
          };
        } catch (cause) {
          const next = [
            { message: (cause as Error).message, source: "server" as const },
          ];
          setIssues(next);
          return { ok: false as const, issues: next };
        }
      },
    };
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>,
}));

const expense: Extract<CalendarItem, { kind: "expense" }> = {
  kind: "expense",
  id: unsafeExpenseShortcode("EXP-1111"),
  title: "Freezer tray",
  startDate: "2026-08-18",
  endDateExclusive: "2026-08-19",
  interaction: "move",
  cost: 79,
  future: true,
  vendor: "Target",
  trade: "other",
  projectName: null,
  productName: "Souper Cubes",
  coverImageUrl: null,
};

describe("EditableCalendarItem", () => {
  it("submits one complete atomic update", async () => {
    session.save.mockResolvedValue(undefined);
    render(
      <EditableCalendarItem
        item={expense}
        edit={
          calendarItemEditDescriptor(expense) as Extract<
            ReturnType<typeof calendarItemEditDescriptor>,
            { mode: "editable" }
          >
        }
        onCancel={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Large freezer tray" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(session.save).toHaveBeenCalledTimes(1));
    expect(session.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Large freezer tray",
        date: "2026-08-18",
        cost: 79,
      }),
    );
  });

  it("retains edited values and shows the inline error when saving fails", async () => {
    session.save.mockRejectedValue(new Error("Ledger unavailable"));
    render(
      <EditableCalendarItem
        item={expense}
        edit={
          calendarItemEditDescriptor(expense) as Extract<
            ReturnType<typeof calendarItemEditDescriptor>,
            { mode: "editable" }
          >
        }
        onCancel={() => undefined}
      />,
    );
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "Keep this edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Ledger unavailable")).toBeInTheDocument();
    expect(name).toHaveValue("Keep this edit");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("keeps actual expenses read-only with a full-record route", () => {
    render(
      <CalendarInspectorBody
        item={{ ...expense, interaction: "read-only", future: false }}
        onCancel={() => undefined}
      />,
    );

    expect(
      screen.getByText(/Recorded expenses stay read-only/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open full record" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
