import { aiSmokeInputs, type AiSmokeScenario } from "@cubby/schemas/ai-smoke";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { formatDuration } from "~/lib/format-duration";
import { getAiSmokeCatalog, runAiSmokeCase } from "~/server-functions/ai-smoke";

import {
  AiSmokeForm,
  defaultSmokeInput,
  type SmokeFormValue,
} from "./ai-smoke-form";

type SmokeResult = Awaited<ReturnType<typeof runAiSmokeCase>>;
type Scenario = Awaited<ReturnType<typeof getAiSmokeCatalog>>[number];
type SmokeOperations = {
  catalog: () => Promise<Scenario[]>;
  run: (
    scenario: AiSmokeScenario,
    input: z.infer<ReturnType<typeof z.json>>,
  ) => Promise<SmokeResult>;
};
const productionSmokeOperations: SmokeOperations = {
  catalog: () => getAiSmokeCatalog(),
  run: (scenario, input) => runAiSmokeCase({ data: { scenario, input } }),
};

const sourcePrerequisites = {
  usdaFood: "Choose an ingredient to search the USDA catalog.",
  usdaFoodBatch: "Choose at least one ingredient for the batch.",
  ingredientMerge: "Choose at least one ingredient to compare.",
  productIdentification: "Choose at least one uploaded product image.",
  locationDescription: "Choose a location with uploaded images.",
  inventoryDetection: "Choose a location with uploaded images.",
  imageDescription: "Choose an uploaded image that passed integrity checks.",
  recipeFlow: "Choose a recipe with authored ingredients and instructions.",
  purchaseReceipt: "Choose an uploaded receipt image.",
  entityEmbedding: "Choose a product to embed.",
  purchaseAudit:
    "Choose a Run with imported purchases, or use a synthetic batch.",
} satisfies Partial<Record<Scenario["id"], string>>;

const missingSourceRun = (scenario: AiSmokeScenario, input: SmokeFormValue) =>
  scenario === "purchaseAudit" && input.source === "run" && !input.runId;

// Each probe keeps independent input, validation, execution, and result state.
// eslint-disable-next-line complexity
function ScenarioCard({
  spec,
  operations,
}: {
  spec: Scenario;
  operations: SmokeOperations;
}) {
  const [input, setInput] = useState<SmokeFormValue>(() =>
    defaultSmokeInput(spec.id),
  );
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SmokeResult | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const parsed = aiSmokeInputs[spec.id].safeParse(input);
  const sourceMissing = missingSourceRun(spec.id, input);
  const prerequisite = Object.entries(sourcePrerequisites).find(
    ([id]) => id === spec.id,
  )?.[1];

  const onRun = async () => {
    if (sourceMissing) {
      setValidation("Choose a Run with imported purchases.");
      return;
    }
    if (!parsed.success) {
      setValidation(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      );
      return;
    }
    setValidation(null);
    setResult(null);
    setRunning(true);
    try {
      const response = await operations.run(
        spec.id,
        z.json().parse(parsed.data),
      );
      setResult(response);
    } catch (error) {
      setValidation(getErrorMessage(error));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{spec.label}</CardTitle>
        <CardDescription>{spec.description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Row align="center" gap="sm" wrap>
          <Badge variant="outline">{result?.feature ?? spec.feature}</Badge>
          <Badge variant="outline">{result?.model ?? spec.model}</Badge>
        </Row>
        <AiSmokeForm
          scenario={spec.id}
          schema={spec.inputSchema}
          value={input}
          onChange={(next) => {
            setInput(next);
            setValidation(null);
          }}
        />
        <Row align="center" gap="sm" wrap>
          <Button
            size="sm"
            type="button"
            disabled={running || !parsed.success || sourceMissing}
            onClick={() => void onRun()}
          >
            {running ? (
              <>
                <Spinner size="sm" /> Running
              </>
            ) : (
              "Run"
            )}
          </Button>
          {result && (
            <Badge
              variant={
                result.status === "error"
                  ? "destructive"
                  : result.status === "ok"
                    ? "positive"
                    : "secondary"
              }
            >
              {result.status === "no_model_call"
                ? "no model call"
                : result.status}{" "}
              · {formatDuration(result.durationMs)}
            </Badge>
          )}
          {result && (
            <a
              className="text-sm text-primary underline-offset-2 hover:underline"
              href={`/runs/${encodeURIComponent(result.runShortcode)}`}
            >
              View Run
            </a>
          )}
        </Row>
        {prerequisite && (
          <p className="text-xs text-muted-foreground">
            Prerequisite: {prerequisite}
          </p>
        )}
        {!parsed.success && !prerequisite && (
          <p className="text-xs text-muted-foreground">
            Select the required options to run this probe.
          </p>
        )}
        {validation && (
          <p role="alert" className="text-xs text-destructive">
            {validation}
          </p>
        )}
        {result?.error && (
          <pre className="max-h-56 overflow-auto text-xs whitespace-pre-wrap text-destructive">
            {result.error}
          </pre>
        )}
        {result?.result !== undefined && (
          <pre className="max-h-72 overflow-auto rounded-md bg-muted/40 p-2 text-xs">
            {JSON.stringify(result.result, null, 2)}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

const groupOrder = [
  "Decisions",
  "Vision",
  "Recipes",
  "Purchase import",
  "Embeddings",
];

export function AiSmokeTest({
  operations = productionSmokeOperations,
}: { operations?: SmokeOperations } = {}) {
  const catalog = useQuery({
    queryKey: ["ai-smoke", "catalog"],
    queryFn: operations.catalog,
  });
  if (catalog.isLoading)
    return <p className="text-sm text-muted-foreground">Loading AI probes…</p>;
  if (catalog.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        {getErrorMessage(catalog.error)}
      </p>
    );
  const scenarios = catalog.data ?? [];
  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground">
        Choose a source and run one feature at a time. Each attempt creates a
        Run with its AI usage and diagnostics.
      </p>
      {groupOrder.map((group) => {
        const items = scenarios.filter((spec) => spec.group === group);
        if (!items.length) return null;
        return (
          <section
            key={group}
            className="grid gap-3"
            aria-labelledby={`smoke-${group.replaceAll(" ", "-")}`}
          >
            <h2
              id={`smoke-${group.replaceAll(" ", "-")}`}
              className="text-lg font-semibold"
            >
              {group}
            </h2>
            <div className="grid gap-4 lg:grid-cols-2">
              {items.map((spec) => (
                <ScenarioCard
                  key={spec.id}
                  spec={spec}
                  operations={operations}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
