/* eslint-disable anti-slop/no-object-parameters, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- This deterministic fake implements and recursively inspects the external OpenAI Responses wire shape. */
import type {
  ScriptStep,
  ScriptValue,
} from "../../../tooling/purchase-agent-script";
import { parseSignal } from "../../../src/server/purchase-agent/signals";

type ResponsesFunctionCall = {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
};

let script: ScriptStep[] | undefined;
let purposeScripts: Record<string, ScriptStep[]> = {};
let sourceScripts: NonNullable<ScriptConfiguration["sourceSteps"]> = [];
let violations: string[] = [];
let expectedInference: ScriptConfiguration["expectedInference"];
/** Each emitted step, in order: what the real import-run agent was told to do. */
let emitted: string[] = [];
/** A waiting model is asked again on every nudge; record the wait once. */
const record = (entry: string) => {
  if (emitted.at(-1) !== entry) emitted.push(entry);
};
/**
 * Gates the test has released. A held response polls this set: workerd does
 * not run a continuation resolved from another request's context, and the
 * agent may abandon a slow model request and ask again.
 */
let released = new Set<string>();

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
  content?: string | Array<{ text?: string }>;
};

/** Read only the tagged messages a researcher actually sees in its transcript. */
function signals(input: InputItem[]) {
  return input
    .flatMap((item) =>
      typeof item.content === "string"
        ? [item.content]
        : (item.content ?? []).flatMap((part) =>
            part.text ? [part.text] : [],
          ),
    )
    .flatMap((text) => {
      const signal = parseSignal(text);
      return signal ? [signal] : [];
    });
}

function selectedScript(input: InputItem[]) {
  for (const source of sourceScripts) {
    const observed = outputCandidates(toolOutput(input, source.call));
    if (
      observed.some((candidate) => {
        const text = readPath(candidate, source.path);
        return typeof text === "string" && text.includes(source.includes);
      })
    )
      return source.steps;
  }
  for (const signal of signals(input)) {
    if (signal.type !== "purchase-import.start_or_resume") continue;
    const event = JSON.parse(signal.body) as { purpose?: string };
    if (event.purpose && purposeScripts[event.purpose])
      return purposeScripts[event.purpose]!;
  }
  return script!;
}

type ScriptConfiguration = {
  steps: ScriptStep[];
  expectedInference?: {
    model: string;
    effort: string;
    afterCall?: { call: string; model: string; effort: string };
  };
  purposeSteps?: Record<string, ScriptStep[]>;
  /** Branch only on a retained source the real researcher has already read. */
  sourceSteps?: Array<{
    call: string;
    path: string;
    includes: string;
    steps: ScriptStep[];
  }>;
};
function configureScript(configured: ScriptConfiguration) {
  script = configured.steps;
  expectedInference = configured.expectedInference;
  purposeScripts = configured.purposeSteps ?? {};
  sourceScripts = configured.sourceSteps ?? [];
  violations = [];
  emitted = [];
  released = new Set();
}

/** Every JSON reading of a tool output: agent text, MCP content, structured content. */
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

/** The workflow instructions name the run as `(runId <uuid>)`. */
const runIdPattern = /\(runId ([0-9a-f-]{36})\)/u;

function resolveValue(
  value: ScriptValue,
  input: InputItem[],
  stepId: string,
  requestBody = "",
): unknown {
  if (Array.isArray(value))
    return value.map((item) => resolveValue(item, input, stepId, requestBody));
  if (!value || typeof value !== "object") return value;
  if ("$runId" in value) {
    const runId = runIdPattern.exec(requestBody)?.[1];
    if (runId) return runId;
    violations.push(`${stepId}: the request named no runId`);
    return null;
  }
  if ("$from" in value && typeof value.$from === "string") {
    const path = typeof value.path === "string" ? value.path : "";
    for (const candidate of outputCandidates(toolOutput(input, value.$from))) {
      const found = readPath(candidate, path);
      if (found !== undefined) return found;
    }
    violations.push(`${stepId}: ${value.$from}.${path} was not in its output`);
    return null;
  }
  if ("$signal" in value && typeof value.$signal === "string") {
    const path = typeof value.path === "string" ? value.path : "";
    for (const signal of signals(input).reverse()) {
      if (signal.type !== value.$signal) continue;
      const found = readPath(JSON.parse(signal.body), path);
      if (found !== undefined) return found;
    }
    violations.push(
      `${stepId}: ${value.$signal}.${path} was not in its visible signal`,
    );
    return null;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resolveValue(item as ScriptValue, input, stepId, requestBody),
    ]),
  );
}

async function holdAt(name: string) {
  if (released.has(name)) return;
  record(`gate:${name}`);
  while (!released.has(name))
    await new Promise((resolve) => setTimeout(resolve, 25));
}

const isFinishNudge = (item: unknown) =>
  JSON.stringify(item).includes('<signal type=\\"run_not_finished\\">');

/**
 * Regression: the agent once nudged after a terminating tool (a pending
 * browser command) and re-nudged each cycle from a stale guard, so under CI
 * load it hit the agent's 32-cycle runaway ceiling before browser evidence joined.
 * Either misbehavior is recorded deterministically, without needing the race;
 * the harness reads them from `/violations`. The agent retries a model error
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
 * Deterministic coordinator for real agent runs: it plays one scenario script,
 * choosing the first step whose effect is not yet in the conversation. Tool
 * arguments may read prior tool outputs, so ids the server mints (browser
 * command ids, purchase codes) flow through the conversation the way a real
 * model would carry them.
 */
function checkInference(body: {
  model?: string;
  reasoning?: { effort?: string };
}) {
  const expected =
    expectedInference?.afterCall &&
    issued(JSON.stringify(body), expectedInference.afterCall.call)
      ? expectedInference.afterCall
      : expectedInference;
  if (
    expected &&
    (body.model !== expected.model ||
      body.reasoning?.effort !== expected.effort)
  ) {
    violations.push(
      `Inference requested ${body.model}/${body.reasoning?.effort}; expected ${expected.model}/${expected.effort}`,
    );
  }
}

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/configure" && request.method === "POST") {
      configureScript((await request.json()) as ScriptConfiguration);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/release" && request.method === "POST") {
      const name = ((await request.json()) as { gate: string }).gate;
      released.add(name);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/violations") return Response.json(violations);
    if (url.pathname === "/emitted") return Response.json(emitted);
    if (!script)
      return new Response("Script is not configured", { status: 409 });

    const body = (await request.json()) as {
      input?: InputItem[];
      model?: string;
      reasoning?: { effort?: string };
    };
    checkInference(body);
    const input = body.input ?? [];
    const steps = selectedScript(input);
    const requestBody = JSON.stringify(body);
    const browserCalls = new Set(
      steps.flatMap((step) =>
        "call" in step && step.tool === "issue_browser_command"
          ? [step.call]
          : [],
      ),
    );
    const violation = finishNudgeViolation(input, browserCalls);
    if (violation) violations.push(violation);

    for (const step of steps) {
      if ("call" in step) {
        if (issued(requestBody, step.call)) continue;
        emitted.push(step.call);
        return toolResponse({
          type: "function_call",
          id: step.call,
          call_id: step.call,
          name: step.tool,
          arguments: JSON.stringify(
            resolveValue(step.args, input, step.call, requestBody),
          ),
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
      if ("gate" in step) {
        await holdAt(step.gate);
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
