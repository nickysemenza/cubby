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

  it("lets Jev targets drive basis controls without a JSON editor", () => {
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
    expect(screen.getByLabelText("Entity")).toHaveValue("product");
    expect(screen.getByLabelText("Basis mode")).toHaveValue("provided");
    expect(screen.getByLabelText("Basis · name")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("categoryId"));
    expect(screen.queryByLabelText("Basis · name")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Basis mode"), {
      target: { value: "suggested" },
    });
    expect(screen.getByLabelText("Basis mode")).toHaveValue("suggested");
  });

  it("switches an audit between synthetic inputs and a public Run picker", () => {
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
    fireEvent.change(screen.getByLabelText("source"), {
      target: { value: "run" },
    });
    expect(screen.queryByLabelText("fixture")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "runId" })).toBeInTheDocument();
  });
});
