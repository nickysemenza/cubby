import type { AiSmokeScenario } from "@cubby/schemas/ai-smoke";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { smokeCatalog } from "~/server/ai/smoke-catalog";

import {
  AiSmokeForm,
  defaultSmokeInput,
  smokeFieldControl,
  smokeObjectSchema,
  type SmokeFormValue,
} from "./ai-smoke-form";

async function chooseOption(name: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name }));
  const row = await screen.findByRole("option", { name: option });
  // Base UI commits a mouse click only after a pointerdown on the same row.
  fireEvent.pointerDown(row);
  fireEvent.click(row);
}

describe("AI smoke form", () => {
  it("has a control for every schema property", () => {
    expect(smokeFieldControl("enabled", { type: "boolean" })).toBe("checkbox");
    for (const scenario of smokeCatalog()) {
      if (scenario.id === "fieldSuggestions") continue;
      const properties =
        smokeObjectSchema.parse(scenario.inputSchema).properties ?? {};
      for (const [name, field] of Object.entries(properties)) {
        expect(
          smokeFieldControl(name, field),
          `${scenario.id}.${name}`,
        ).not.toBe("unsupported");
      }
    }
  });

  it("lets decision targets drive basis controls without a JSON editor", async () => {
    const scenario: AiSmokeScenario = "fieldSuggestions";
    const schema = smokeCatalog().find(
      (item) => item.id === scenario,
    )!.inputSchema;
    function Form() {
      const [value, setValue] = useState<SmokeFormValue>(
        defaultSmokeInput(scenario),
      );
      return (
        <AiSmokeForm
          scenario={scenario}
          schema={schema}
          value={value}
          onChange={setValue}
        />
      );
    }
    render(<Form />);
    expect(screen.getByLabelText("Entity")).toHaveTextContent("product");
    expect(screen.getByLabelText("Basis mode")).toHaveTextContent("provided");
    expect(screen.getByLabelText("Basis · name")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("categoryId"));
    expect(screen.queryByLabelText("Basis · name")).not.toBeInTheDocument();
    await chooseOption("Basis mode", "suggested");
    expect(screen.getByLabelText("Basis mode")).toHaveTextContent("suggested");
    await chooseOption("Entity", "project");
    fireEvent.click(screen.getByLabelText("defaultTrade"));
    expect(
      screen.getByRole("combobox", { name: "Basis · kind" }),
    ).toHaveTextContent("Unspecified");
  });

  it("switches an audit between synthetic inputs and a public Run picker", async () => {
    const scenario = "purchaseAudit" as const;
    const schema = smokeCatalog().find(
      (item) => item.id === scenario,
    )!.inputSchema;
    function Form() {
      const [value, setValue] = useState<SmokeFormValue>(
        defaultSmokeInput(scenario),
      );
      return (
        <AiSmokeForm
          scenario={scenario}
          schema={schema}
          value={value}
          onChange={setValue}
        />
      );
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Form />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("fixture")).toBeInTheDocument();
    await chooseOption("source", "run");
    expect(screen.queryByLabelText("fixture")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "runId" })).toBeInTheDocument();
  });
});
