import { agentAskInputSchema, agentResultSchema } from "@cubby/schemas/agent";
import {
  aiLocationIdInput,
  categoryAuditSchema,
  categorySuggestionInput,
  categorySuggestionSchema,
  detectedInventorySchema,
  locationSuggestionInput,
  locationSuggestionSchema,
  locationTypeSuggestionInput,
  locationTypeSuggestionSchema,
  productIdentificationInput,
  productIdentificationSchema,
  usdaFoodSuggestionInput,
  usdaFoodSuggestionOut,
} from "@cubby/schemas/ai";
import { useState } from "react";
import { z } from "zod";

import { useAgentStream } from "~/app/_components/hooks/useAgentStream";
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
import { agent } from "~/lib/agent.functions";
import { ai } from "~/lib/ai.functions";
import { getErrorMessage } from "~/lib/error-utils";

/** The registry model each spec's code path actually runs on, shown per card
 * instead of one global badge now that every feature can pick its own tier. */
const FAST_TIER_MODEL = "gpt-5.6-luna";
const REASONING_TIER_MODEL = "claude-sonnet-5";

const jsonValueSchema = z.json();
type JsonValue = z.infer<typeof jsonValueSchema>;
type SmokeResult =
  | z.infer<typeof categorySuggestionSchema>
  | z.infer<typeof locationTypeSuggestionSchema>
  | z.infer<typeof locationSuggestionSchema>
  | z.infer<typeof usdaFoodSuggestionOut>
  | z.infer<typeof productIdentificationSchema>
  | z.infer<typeof detectedInventorySchema>
  | z.infer<typeof categoryAuditSchema>
  | z.infer<typeof agentResultSchema>;

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
    key: "suggestCategory",
    label: "ai.suggestCategory",
    description: "Structured output — product → category",
    model: FAST_TIER_MODEL,
    defaultInput: { productName: "cordless drill", manufacturer: "DeWalt" },
    run: (i) => ai.suggestCategory.call(categorySuggestionInput.parse(i)),
  },
  {
    key: "suggestLocationType",
    label: "ai.suggestLocationType",
    description: "Structured output — location name → type",
    model: FAST_TIER_MODEL,
    defaultInput: { locationName: "workbench drawer 3" },
    run: (i) =>
      ai.suggestLocationType.call(locationTypeSuggestionInput.parse(i)),
  },
  {
    key: "suggestLocation",
    label: "ai.suggestLocation",
    description:
      "Shortlist + one structured call over your real location roster — product → where to put it",
    model: FAST_TIER_MODEL,
    defaultInput: { productId: "PRD-XXXX" },
    run: (i) => ai.suggestLocation.call(locationSuggestionInput.parse(i)),
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
    key: "auditCategories",
    label: "ai.auditCategories",
    description: "Structured output over your real product catalog",
    model: REASONING_TIER_MODEL,
    defaultInput: undefined,
    run: () => ai.auditCategories.call(),
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
  {
    key: "agentAsk",
    label: "agent.ask",
    description: "Agentic MCP loop (non-streaming) over your data",
    model: REASONING_TIER_MODEL,
    defaultInput: { query: "how many products do I have?" },
    run: (i) => agent.ask.call(agentAskInputSchema.parse(i)),
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

function AgentStreamCard() {
  const stream = useAgentStream();
  const [query, setQuery] = useState("how many products do I have?");

  return (
    <Card>
      <CardHeader>
        <CardTitle>agent.askStream</CardTitle>
        <CardDescription>
          Streaming agent — live token + tool reveal
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          rows={2}
        />
        <Row align="center" gap="sm">
          <Button
            size="sm"
            onClick={() => stream.ask(query)}
            disabled={stream.isStreaming}
          >
            Run
          </Button>
          {stream.isStreaming && (
            <Badge variant="secondary">
              <Spinner size="sm" />{" "}
              {stream.toolStatus ? `tool: ${stream.toolStatus}` : "streaming"}
            </Badge>
          )}
          {!stream.isStreaming && stream.result && (
            <Badge variant="positive">
              done · {stream.result.toolCalls.length} tool call(s)
            </Badge>
          )}
        </Row>
        {stream.error && (
          <pre className="overflow-auto text-2xs whitespace-pre-wrap text-destructive">
            {stream.error}
          </pre>
        )}
        {stream.answer && (
          <div className="max-h-72 overflow-auto rounded-md bg-muted/40 p-2 text-xs/relaxed whitespace-pre-wrap">
            {stream.answer}
          </div>
        )}
        {stream.result && stream.result.sources.length > 0 && (
          <Description size="2xs">
            sources: {stream.result.sources.map((s) => s.name).join(", ")}
          </Description>
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
          Run all (non-streaming)
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
        <AgentStreamCard />
      </div>
    </div>
  );
}
