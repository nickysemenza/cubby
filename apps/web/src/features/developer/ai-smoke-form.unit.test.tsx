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

  it("edits plain string inputs and structured JSON inputs", () => {
    const titleSchema = smokeCatalog().find(
      (item) => item.id === "upcOfferComparability",
    )!.inputSchema;
    function TitleForm() {
      const [value, setValue] = useState<SmokeFormValue>({
        itemTitle: "Synthetic item",
        offerTitle: "Synthetic offer",
      });
      return (
        <AiSmokeForm
          scenario="upcOfferComparability"
          schema={titleSchema}
          value={value}
          onChange={setValue}
        />
      );
    }
    render(<TitleForm />);
    expect(screen.getByLabelText("item Title")).toHaveValue("Synthetic item");
    fireEvent.change(screen.getByLabelText("item Title"), {
      target: { value: "Updated synthetic item" },
    });
    expect(screen.getByLabelText("item Title")).toHaveValue(
      "Updated synthetic item",
    );

    const structuredSchema = {
      properties: { image: { type: "object" } },
      required: ["image"],
    };
    function StructuredForm() {
      const [value, setValue] = useState<SmokeFormValue>({
        image: { url: "https://example.test/photo.jpg" },
      });
      return (
        <>
          <output data-testid="structured-value">
            {JSON.stringify(value.image)}
          </output>
          <AiSmokeForm
            scenario="imageIdentification"
            schema={structuredSchema}
            value={value}
            onChange={setValue}
          />
        </>
      );
    }
    render(<StructuredForm />);
    const imageInput = screen.getByLabelText("image");
    expect(imageInput).toHaveValue(
      JSON.stringify({ url: "https://example.test/photo.jpg" }, null, 2),
    );
    fireEvent.change(imageInput, {
      target: { value: '{"url":"https://example.test/updated.jpg"}' },
    });
    expect(screen.getByLabelText("image")).toHaveValue(
      '{"url":"https://example.test/updated.jpg"}',
    );
    fireEvent.change(imageInput, { target: { value: "{invalid" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId("structured-value")).toHaveTextContent(
      JSON.stringify("{invalid"),
    );
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
