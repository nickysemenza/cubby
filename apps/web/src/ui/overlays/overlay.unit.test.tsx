import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FormWrapper, UnifiedTextField } from "~/ui/forms/form-utils";

import { Overlay } from "./overlay";

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

// Real external native submission must stay isolated from ancestor forms, and
// dismissal must remain blocked during both resolver validation and completion.
for (const mobile of [false, true]) {
  it(`owns native actions through validation and completion (${mobile ? "phone" : "desktop"})`, async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: mobile,
        addEventListener() {},
        removeEventListener() {},
      })),
    );
    const validation = deferred();
    const completion = deferred();
    const parentSubmit = vi.fn();
    const save = vi.fn(async () => {
      await completion.promise;
    });
    function Example() {
      const [open, setOpen] = useState(true);
      const [pending, setPending] = useState(false);
      const form = useForm({
        defaultValues: { name: "Synthetic part" },
        resolver: async (values) => {
          await validation.promise;
          return { values, errors: {} };
        },
      });
      return (
        <form onSubmit={parentSubmit}>
          <Overlay
            open={open}
            onOpenChange={setOpen}
            title="Review part"
            pending={pending}
            primary={{ label: "Apply", form: "part-form" }}
            bodyMode="form"
          >
            <FormWrapper
              form={form}
              id="part-form"
              hideActions
              onSubmittingChange={setPending}
              isPending={pending}
              submitButtonText="Apply"
              onSubmit={async () => {
                await save();
                setOpen(false);
              }}
            >
              <UnifiedTextField
                form={form}
                name="name"
                label="Name"
                placeholder="Part name"
              />
            </FormWrapper>
          </Overlay>
        </form>
      );
    }
    render(<Example />);
    expect(screen.getAllByRole("button", { name: "Apply" })).toHaveLength(1);
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toHaveAttribute("form", "part-form");
    expect(
      document.querySelectorAll('[data-slot="overlay-actions"]'),
    ).toHaveLength(mobile ? 0 : 1);
    fireEvent.click(apply);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled(),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    validation.resolve();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(
      screen
        .queryByRole("button", { name: "Close" })
        ?.hasAttribute("disabled") ?? true,
    ).toBe(true);
    completion.resolve();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(parentSubmit).not.toHaveBeenCalled();
  });
}

it("shows a rejected resolver even when the caller supplies an empty error list", async () => {
  function Example() {
    const [pending, setPending] = useState(false);
    const form = useForm({
      defaultValues: { name: "Part" },
      resolver: async () => {
        throw new Error("SQLSTATE 22000: synthetic resolver failure");
      },
    });
    return (
      <Overlay
        open
        onOpenChange={() => undefined}
        title="Review part"
        pending={pending}
        primary={{ label: "Apply", form: "failed-form" }}
      >
        <FormWrapper
          form={form}
          id="failed-form"
          hideActions
          error={[]}
          isPending={pending}
          onSubmittingChange={setPending}
          onSubmit={vi.fn()}
          submitButtonText="Apply"
        >
          Fields
        </FormWrapper>
      </Overlay>
    );
  }
  render(<Example />);
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "SQLSTATE 22000: synthetic resolver failure",
  );
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
});

describe("ordinary overlay actions", () => {
  it("blocks dismissal for a returned promise and exposes failure for retry", async () => {
    const write = deferred();
    const change = vi.fn();
    const save = vi
      .fn()
      .mockImplementationOnce(async () => {
        await write.promise;
        throw new Error("SQLSTATE 23514: synthetic_part_check");
      })
      .mockResolvedValue(undefined);
    render(
      <Overlay
        open
        onOpenChange={change}
        title="Attach part"
        primary={{ label: "Attach", pendingLabel: "Attaching…", onClick: save }}
      >
        Selected part
      </Overlay>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(screen.getByRole("button", { name: /Attaching…/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(change).not.toHaveBeenCalled();
    write.resolve();
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "SQLSTATE 23514: synthetic_part_check",
    );
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
  });

  it("keeps an explicit Done action on an independent-row surface", () => {
    const change = vi.fn();
    render(
      <Overlay open onOpenChange={change} title="Inventory" cancelLabel="Done">
        Rows save independently
      </Overlay>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(change).toHaveBeenCalledWith(false);
  });

  it("allows Cancel when only the primary submission gate is disabled", () => {
    const cancel = vi.fn();
    render(
      <Overlay
        open
        onOpenChange={() => undefined}
        onCancel={cancel}
        title="Choose part"
        primary={{ label: "Attach", disabled: true, onClick: vi.fn() }}
      />,
    );
    expect(screen.getByRole("button", { name: "Attach" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
