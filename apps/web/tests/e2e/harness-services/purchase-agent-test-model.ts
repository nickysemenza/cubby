/* eslint-disable anti-slop/no-object-parameters, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- This deterministic fake implements and recursively inspects the external OpenAI Responses wire shape. */
import type {
  ScriptStep,
  ScriptValue,
} from "../../../tooling/purchase-agent-script";

type ResponsesFunctionCall = {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
};

let script: ScriptStep[] | undefined;
let violations: string[] = [];
/** Each emitted step, in order: what the real Flue agent was told to do. */
let emitted: string[] = [];
/** A waiting model is asked again on every nudge; record the wait once. */
const record = (entry: string) => {
  if (emitted.at(-1) !== entry) emitted.push(entry);
};

function sse(event: object) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function streamed(item: object, id: string) {
  const response = {
    id,
    status: "completed",
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  return new Response(
    [
      sse({ type: "response.created", response: { id: response.id } }),
      sse({ type: "response.output_item.added", output_index: 0, item }),
      sse({ type: "response.output_item.done", output_index: 0, item }),
      sse({ type: "response.completed", response }),
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const toolResponse = (call: ResponsesFunctionCall) =>
  streamed(call, `workerd-${call.id}`);

const textResponse = (text: string) =>
  streamed(
    {
      type: "message",
      id: "workerd-text",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    },
    "workerd-text",
  );

type InputItem = {
  type?: string;
  call_id?: string;
  output?: unknown;
};

/** Every JSON reading of a tool output: Flue text, MCP content, structured content. */
function outputCandidates(value: unknown, depth = 0): unknown[] {
  if (depth > 4) return [];
  if (typeof value === "string") {
    try {
      return outputCandidates(JSON.parse(value), depth + 1);
    } catch {
      return [value];
    }
  }
  if (Array.isArray(value))
    return [
      value,
      ...value.flatMap((part) =>
        part && typeof part === "object" && "text" in part
          ? outputCandidates((part as { text: unknown }).text, depth + 1)
          : [],
      ),
    ];
  if (!value || typeof value !== "object") return [value];
  const record = value as Record<string, unknown>;
  return [
    record,
    ...(record.structuredContent
      ? outputCandidates(record.structuredContent, depth + 1)
      : []),
    ...(Array.isArray(record.content)
      ? outputCandidates(record.content, depth + 1)
      : []),
  ];
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function toolOutput(input: InputItem[], callId: string) {
  return input.find(
    (item) => item.type === "function_call_output" && item.call_id === callId,
  )?.output;
}

function resolveValue(
  value: ScriptValue,
  input: InputItem[],
  stepId: string,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => resolveValue(item, input, stepId));
  if (!value || typeof value !== "object") return value;
  if ("$from" in value && typeof value.$from === "string") {
    const path = typeof value.path === "string" ? value.path : "";
    for (const candidate of outputCandidates(toolOutput(input, value.$from))) {
      const found = readPath(candidate, path);
      if (found !== undefined) return found;
    }
    violations.push(`${stepId}: ${value.$from}.${path} was not in its output`);
    return null;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resolveValue(item as ScriptValue, input, stepId),
    ]),
  );
}

const isFinishNudge = (item: unknown) =>
  JSON.stringify(item).includes('<signal type=\\"run_not_finished\\">');

/**
 * Regression: the agent once nudged after a terminating tool (a pending
 * browser command) and re-nudged each cycle from a stale guard, so under CI
 * load it hit Flue's 32-cycle runaway ceiling before browser evidence joined.
 * Either misbehavior is recorded deterministically, without needing the race;
 * the harness reads them from `/violations`. Flue retries a model error
 * response, so refusing the request would hide the misbehavior instead.
 */
function finishNudgeViolation(
  input: unknown[],
  browserCalls: ReadonlySet<string>,
): string | undefined {
  const last = input.at(-1);
  if (!isFinishNudge(last)) return undefined;
  const before = input.at(-2) as InputItem | undefined;
  if (
    before?.type === "function_call_output" &&
    before.call_id &&
    browserCalls.has(before.call_id)
  )
    return "Finish nudge after a pending browser command";
  for (const item of input.slice(0, -1).reverse()) {
    if ((item as InputItem).type === "function_call_output") return undefined;
    if (isFinishNudge(item))
      return "Repeated finish nudge without a new tool call";
  }
  return undefined;
}

const issued = (body: string, callId: string) =>
  body.includes(`"call_id":"${callId}"`);

/**
 * Deterministic coordinator for real Flue runs: it plays one scenario script,
 * choosing the first step whose effect is not yet in the conversation. Tool
 * arguments may read prior tool outputs, so ids the server mints (browser
 * command ids, purchase codes) flow through the conversation the way a real
 * model would carry them.
 */
export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/configure" && request.method === "POST") {
      script = ((await request.json()) as { steps: ScriptStep[] }).steps;
      violations = [];
      emitted = [];
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/violations") return Response.json(violations);
    if (url.pathname === "/emitted") return Response.json(emitted);
    if (!script)
      return new Response("Script is not configured", { status: 409 });

    const body = (await request.json()) as { input?: InputItem[] };
    const input = body.input ?? [];
    const requestBody = JSON.stringify(body);
    const browserCalls = new Set(
      script.flatMap((step) =>
        "call" in step && step.tool === "issue_browser_command"
          ? [step.call]
          : [],
      ),
    );
    const violation = finishNudgeViolation(input, browserCalls);
    if (violation) violations.push(violation);

    for (const step of script) {
      if ("call" in step) {
        if (issued(requestBody, step.call)) continue;
        emitted.push(step.call);
        return toolResponse({
          type: "function_call",
          id: step.call,
          call_id: step.call,
          name: step.tool,
          arguments: JSON.stringify(resolveValue(step.args, input, step.call)),
        });
      }
      if ("check" in step) {
        const output = JSON.stringify(toolOutput(input, step.check) ?? null);
        if (!output.includes(step.includes)) {
          const message = `${step.check} output lacks ${step.includes}: ${output.slice(0, 500)}`;
          if (!violations.includes(message)) violations.push(message);
        }
        continue;
      }
      const markers = step.await.map((marker) =>
        typeof marker === "string"
          ? marker
          : `${marker.prefix}${String(resolveValue({ $from: marker.$from, path: marker.path }, input, "await"))}`,
      );
      if (markers.some((marker) => requestBody.includes(marker))) continue;
      record(`await:${markers.join("|")}`);
      return textResponse(step.text ?? "Waiting for the next run event.");
    }
    record("script-complete");
    return textResponse("The scripted scenario has no further steps.");
  },
};
