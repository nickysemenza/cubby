/**
 * Queue events reach the coordinator as user text in one
 * tagged form. Keep these bytes stable: the coordinator prompt, the workerd
 * scripted model, and its await markers all match `<signal type="…">`.
 */
export type AgentSignal = {
  type: string;
  attributes?: Record<string, string>;
  body: string;
};

const escapeAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
const unescapeAttribute = (value: string) =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");

export function renderSignal({ type, attributes, body }: AgentSignal): string {
  const rendered = Object.entries({ type, ...attributes })
    .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
    .join(" ");
  return `<signal ${rendered}>${body}</signal>`;
}

const SIGNAL = /^<signal ((?:[\w.-]+="[^"]*"\s*)+)>([\s\S]*)<\/signal>$/u;
const ATTRIBUTE = /([\w.-]+)="([^"]*)"/gu;

/** The signal a whole user entry carries, or `undefined` for member text. */
export function parseSignal(text: string): AgentSignal | undefined {
  const [, rendered, body] = SIGNAL.exec(text) ?? [];
  if (rendered === undefined || body === undefined) return undefined;
  const attributes: Record<string, string> = {};
  for (const [, key, value] of rendered.matchAll(ATTRIBUTE))
    if (key !== undefined && value !== undefined)
      attributes[key] = unescapeAttribute(value);
  const { type, ...rest } = attributes;
  if (!type) return undefined;
  const signal: AgentSignal = { type, body };
  if (Object.keys(rest).length > 0) signal.attributes = rest;
  return signal;
}

/** Consume broker results on the host before the model sees a retained observation. */
export async function resumeResearchSignal(
  signal: AgentSignal,
  resume: (signal: AgentSignal) => Promise<object | null>,
): Promise<AgentSignal | null> {
  const observation = await resume(signal);
  // A stopped host task must not wake a parked model after cancellation or retirement.
  if (
    observation &&
    "status" in observation &&
    observation.status === "stopped"
  )
    return null;
  if (observation)
    return { type: "research_observation", body: JSON.stringify(observation) };
  if (signal.type === "purchase-import.browser_result") return null;
  return signal;
}
