import {
  aiLocationIdInput,
  detectedInventorySchema,
  fieldSuggestionsInput,
  fieldSuggestionsOut,
  productIdentificationInput,
  productIdentificationSchema,
  usdaFoodSuggestionInput,
  usdaFoodSuggestionOut,
} from "@cubby/schemas/ai";
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
import { Description } from "~/components/ui/description";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { ai } from "~/lib/ai.functions";
import { getErrorMessage } from "~/lib/error-utils";

/** The registry model each spec's code path actually runs on, shown per card
 * instead of one global badge now that every feature can pick its own tier. */
const FAST_TIER_MODEL = "gpt-5.6-luna";
/** Every `ai.suggestFields` target runs on the decision tier (`classify.ts` /
 * `runAiSelection`), not the fast tier the other cards use. */
const DECISION_TIER_MODEL = "typesafe/jev";

const jsonValueSchema = z.json();
type JsonValue = z.infer<typeof jsonValueSchema>;
type SmokeResult =
  | z.infer<typeof fieldSuggestionsOut>
  | z.infer<typeof usdaFoodSuggestionOut>
  | z.infer<typeof productIdentificationSchema>
  | z.infer<typeof detectedInventorySchema>;

interface EndpointSpec {
  key: string;
  label: string;
  description: string;
  /** The registry model this code path runs on. */
  model: string;
  /** Prefilled JSON input, or undefined for input-less endpoints. */
  defaultInput: JsonValue | undefined;
  run: (input: JsonValue) => Promise<SmokeResult>;
}

// Core sweep — one spec per distinct AI code path. Inputs are edited as JSON
// for uniformity across shapes.
const SPECS: EndpointSpec[] = [
  {
    key: "suggestFields",
    label: "ai.suggestFields",
    description:
      "Manifest-driven field auto-suggest — one round trip, targets resolved in dependency order (enum, reference, or roster-backed text)",
    model: DECISION_TIER_MODEL,
    defaultInput: {
      entity: "product",
      basisMode: "provided",
      targets: ["category"],
      basis: { name: "cordless drill", manufacturer: "DeWalt" },
    },
    run: (i) => ai.suggestFields.call(fieldSuggestionsInput.parse(i)),
  },
  {
    key: "suggestUsdaFood",
    label: "ai.suggestUsdaFood",
    description: "Shortlist + one structured call — search USDA, then select",
    model: FAST_TIER_MODEL,
    defaultInput: { ingredientName: "olive oil" },
    run: (i) => ai.suggestUsdaFood.call(usdaFoodSuggestionInput.parse(i)),
  },
  {
    key: "identifyProduct",
    label: "ai.identifyProduct",
    description:
      "Vision — paste 1-5 public image URLs (R2 images work; the gateway fetches them server-side)",
    model: FAST_TIER_MODEL,
    defaultInput: {
      imageUrls: [`${__R2_PUBLIC_URL__}/cubby/replace-with-a-real-key.jpg`],
    },
    run: (i) => ai.identifyProduct.call(productIdentificationInput.parse(i)),
  },
  {
    key: "detectInventoryItems",
    label: "ai.detectInventoryItems",
    description:
      "Vision — cached structured location inventory detection with product matching",
    model: FAST_TIER_MODEL,
    defaultInput: { locationId: "replace-with-location-uuid" },
    run: (i) => ai.detectInventoryItems.call(aiLocationIdInput.parse(i)),
  },
];

type RunStatus = "idle" | "running" | "ok" | "error";

interface RunState {
  status: RunStatus;
  ms?: number;
  result?: SmokeResult;
  error?: string;
}

function StatusBadge({ state }: { state: RunState }) {
  if (state.status === "running") {
    return (
      <Badge variant="secondary">
        <Spinner size="sm" /> running
      </Badge>
    );
  }
  if (state.status === "ok") {
    return <Badge variant="positive">ok · {state.ms}ms</Badge>;
  }
  if (state.status === "error") {
    return <Badge variant="destructive">error · {state.ms}ms</Badge>;
  }
  return <Badge variant="outline">idle</Badge>;
}

function EndpointCard({
  spec,
  input,
  state,
  onInputChange,
  onRun,
}: {
  spec: EndpointSpec;
  input: string | null;
  state: RunState;
  onInputChange: (value: string) => void;
  onRun: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{spec.label}</CardTitle>
        <CardDescription>{spec.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Row align="center" gap="sm">
          <Badge variant="outline">model: {spec.model}</Badge>
        </Row>
        {input !== null && (
          <Textarea
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            spellCheck={false}
            className="font-mono text-2xs"
            rows={input.split("\n").length + 1}
          />
        )}
        <Row align="center" gap="sm">
          <Button
            size="sm"
            onClick={onRun}
            disabled={state.status === "running"}
          >
            Run
          </Button>
          <StatusBadge state={state} />
        </Row>
        {state.error && (
          <pre className="overflow-auto text-2xs whitespace-pre-wrap text-destructive">
            {state.error}
          </pre>
        )}
        {state.result !== undefined && (
          <pre className="max-h-72 overflow-auto rounded-md bg-muted/40 p-2 text-2xs">
            {JSON.stringify(state.result, null, 2)}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

export function AiSmokeTest() {
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      SPECS.filter((s) => s.defaultInput !== undefined).map((s) => [
        s.key,
        JSON.stringify(s.defaultInput, null, 2),
      ]),
    ),
  );
  const [states, setStates] = useState<Record<string, RunState>>(() =>
    Object.fromEntries(SPECS.map((s) => [s.key, { status: "idle" }])),
  );

  const runOne = async (spec: EndpointSpec) => {
    setStates((m) => ({ ...m, [spec.key]: { status: "running" } }));
    let parsed: JsonValue | undefined;
    try {
      parsed =
        spec.defaultInput === undefined
          ? undefined
          : jsonValueSchema.parse(JSON.parse(inputs[spec.key] ?? "null"));
    } catch (e) {
      setStates((m) => ({
        ...m,
        [spec.key]: { status: "error", ms: 0, error: getErrorMessage(e) },
      }));
      return;
    }
    const t0 = performance.now();
    try {
      const result = await spec.run(parsed ?? null);
      setStates((m) => ({
        ...m,
        [spec.key]: {
          status: "ok",
          ms: Math.round(performance.now() - t0),
          result: result ?? null,
        },
      }));
    } catch (e) {
      setStates((m) => ({
        ...m,
        [spec.key]: {
          status: "error",
          ms: Math.round(performance.now() - t0),
          error: getErrorMessage(e),
        },
      }));
    }
  };

  const runAll = async () => {
    for (const spec of SPECS) {
      await runOne(spec);
    }
  };

  const mode = import.meta.env.DEV
    ? "dev — gateway REST"
    : "prod — gateway binding";

  return (
    <div className="flex flex-col gap-4">
      <Row align="center" wrap gap="sm">
        <Badge variant="secondary">{mode}</Badge>
        <Description as="span" size="2xs">
          In prod this exercises the real <code>env.AI.gateway("cubby")</code>{" "}
          binding path — the only place it's testable end-to-end.
        </Description>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={runAll}
        >
          Run all
        </Button>
      </Row>
      <div className="grid gap-4 md:grid-cols-2">
        {SPECS.map((spec) => (
          <EndpointCard
            key={spec.key}
            spec={spec}
            input={
              spec.defaultInput === undefined ? null : (inputs[spec.key] ?? "")
            }
            state={states[spec.key] ?? { status: "idle" }}
            onInputChange={(value) =>
              setInputs((m) => ({ ...m, [spec.key]: value }))
            }
            onRun={() => void runOne(spec)}
          />
        ))}
      </div>
    </div>
  );
}
