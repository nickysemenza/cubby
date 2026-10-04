import vectorFile from "@cubby/shared/golden-vectors/structured-roundtrip.json";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type FieldValues, FormProvider, useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { structuredSchemaFor } from "./structured-schema";
import { StructuredValueField } from "./structured-value-field";

const inputOf = (entity: string, field: string) =>
  z
    .array(z.object({ entity: z.string(), field: z.string(), input: z.json() }))
    .parse(vectorFile.vectors)
    .find((vector) => vector.entity === entity && vector.field === field)
    ?.input;

function Harness({
  entity,
  field,
  label,
  initial,
  onSubmit,
}: {
  entity: string;
  field: string;
  label: string;
  initial: z.core.util.JSONType;
  onSubmit: (value: z.core.util.JSONType) => void;
}) {
  const schema = structuredSchemaFor(entity, field);
  if (schema === undefined) throw new Error(`no schema for ${entity}.${field}`);
  const form = useForm<FieldValues>({ defaultValues: { [field]: initial } });
  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit((values) => onSubmit(values[field]))}>
        <StructuredValueField
          form={form}
          name={field}
          label={label}
          schema={schema}
        />
        <button type="submit">Save</button>
      </form>
    </FormProvider>
  );
}

const choose = (name: string, option: string) => {
  fireEvent.keyDown(screen.getByRole("combobox", { name }), {
    key: "ArrowDown",
  });
  fireEvent.click(screen.getByRole("option", { name: option }));
};

describe("StructuredValueField", () => {
  it("edits a source claim without ever showing or dropping its identity key", async () => {
    const onSubmit = vi.fn();
    const claims = inputOf("expense", "sourceClaims");
    render(
      <Harness
        entity="expense"
        field="sourceClaims"
        label="Source claims"
        initial={claims ?? null}
        onSubmit={onSubmit}
      />,
    );

    // The identity key is carried, never drawn; the person edits the review decision.
    expect(screen.queryByText(/source key/i)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Source" })).toHaveValue(
      "synthetic-provider",
    );
    choose("Reconciliation", "Accept target amount");
    fireEvent.change(await screen.findByRole("textbox", { name: "Note" }), {
      target: { value: "Reviewed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject([
      {
        source: "synthetic-provider",
        sourceKey: expect.stringMatching(/^v1:/u),
        reconciliation: { decision: "accept_target_amount", note: "Reviewed" },
      },
    ]);
  });

  it("makes a new account choose an identity kind instead of defaulting one", async () => {
    const onSubmit = vi.fn();
    render(
      <Harness
        entity="financialAccount"
        field="identity"
        label="Identity"
        initial={null}
        onSubmit={onSubmit}
      />,
    );

    const picker = screen.getByRole("combobox", { name: "Identity" });
    expect(picker).toHaveValue("");
    // No kind is chosen, so none of a kind's fields is drawn yet.
    expect(screen.queryByRole("textbox", { name: "Issuer" })).toBeNull();

    choose("Identity", "Credit card");
    fireEvent.change(await screen.findByRole("textbox", { name: "Issuer" }), {
      target: { value: "Synthetic Bank" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      kind: "credit_card",
      issuer: "Synthetic Bank",
    });
  });

  it("adds and removes rows of a list", async () => {
    const onSubmit = vi.fn();
    render(
      <Harness
        entity="financialAccount"
        field="cardNumbers"
        label="Card numbers"
        initial={[]}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /add card number/i }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Last 4" }), {
      target: { value: "4242" },
    });
    choose("Kind", "Primary");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject([
      { last4: "4242", kind: "primary" },
    ]);
  });
});
