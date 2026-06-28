import { useState } from "react";
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
import { getErrorMessage } from "~/lib/error-utils";
import { useTRPCClient } from "~/trpc/react";

const MODEL = "claude-haiku-4-5";

type TrpcClient = ReturnType<typeof useTRPCClient>;

interface EndpointSpec {
  key: string;
  label: string;
  description: string;
  /** Prefilled JSON input, or undefined for input-less endpoints. */
  defaultInput: unknown;
  run: (client: TrpcClient, input: unknown) => Promise<unknown>;
}

// Core sweep — one spec per distinct AI code path. The vanilla tRPC client is
// called imperatively so queries, mutations (and streaming, below) share one
// run model. Inputs are edited as JSON for uniformity across shapes.
const SPECS: EndpointSpec[] = [
  {
    key: "suggestCategory",
    label: "ai.suggestCategory",
    description: "Structured output — product → category",
    defaultInput: { productName: "cordless drill", manufacturer: "DeWalt" },
    run: (c, i) =>
      c.ai.suggestCategory.query(
        i as { productName: string; manufacturer: string },
      ),
  },
  {
    key: "suggestLocationType",
    label: "ai.suggestLocationType",
    description: "Structured output — location name → type",
    defaultInput: { locationName: "workbench drawer 3" },
    run: (c, i) =>
      c.ai.suggestLocationType.query(i as { locationName: string }),
  },
  {
    key: "parseSearch",
    label: "ai.parseSearch",
    description: "Structured output — free-text search → filters",
    defaultInput: { query: "where are my canned tomatoes in the pantry" },
    run: (c, i) => c.ai.parseSearch.mutate(i as { query: string }),
  },
  {
    key: "suggestUsdaFood",
    label: "ai.suggestUsdaFood",
    description: "Agentic tool loop — search USDA → select best food",
    defaultInput: { ingredientName: "olive oil" },
    run: (c, i) => c.ai.suggestUsdaFood.mutate(i as { ingredientName: string }),
  },
  {
    key: "auditCategories",
    label: "ai.auditCategories",
    description: "Structured output over your real product catalog",
    defaultInput: undefined,
    run: (c) => c.ai.auditCategories.mutate(),
  },
  {
    key: "identifyProduct",
    label: "ai.identifyProduct",
    description:
      "Vision — paste 1-5 public image URLs (R2 images work; Anthropic fetches them server-side)",
    defaultInput: {
      imageUrls: [
        "https://foobucket.nicky.fun/cubby/replace-with-a-real-key.jpg",
      ],
    },
    run: (c, i) => c.ai.identifyProduct.mutate(i as { imageUrls: string[] }),
  },
  {
    key: "detectInventoryItems",
    label: "ai.detectInventoryItems",
    description:
      "Vision — cached structured location inventory detection with product matching",
    defaultInput: { locationId: "replace-with-location-uuid" },
    run: (c, i) =>
      c.ai.detectInventoryItems.mutate(i as { locationId: string }),
  },
  {
    key: "agentAsk",
    label: "agent.ask",
    description: "Agentic MCP loop (non-streaming) over your data",
    defaultInput: { query: "how many products do I have?" },
    run: (c, i) => c.agent.ask.mutate(i as { query: string }),
  },
];

type RunStatus = "idle" | "running" | "ok" | "error";

interface RunState {
  status: RunStatus;
  ms?: number;
  result?: unknown;
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
          <pre className="overflow-auto whitespace-pre-wrap text-2xs text-destructive">
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
          <pre className="overflow-auto whitespace-pre-wrap text-2xs text-destructive">
            {stream.error}
          </pre>
        )}
        {stream.answer && (
          <div className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-xs/relaxed">
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
  const client = useTRPCClient();
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
    let parsed: unknown;
    try {
      parsed =
        spec.defaultInput === undefined
          ? undefined
          : JSON.parse(inputs[spec.key] ?? "null");
    } catch (e) {
      setStates((m) => ({
        ...m,
        [spec.key]: { status: "error", ms: 0, error: getErrorMessage(e) },
      }));
      return;
    }
    const t0 = performance.now();
    try {
      const result = await spec.run(client, parsed);
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
        <Badge variant="outline">model: {MODEL}</Badge>
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
