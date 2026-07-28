/**
 * Shared shell for the MCP Apps (SEP-1865) UI bundles.
 *
 * These run in a sandboxed iframe with no cookies and no access to the parent
 * page, so there is no tRPC and no cubby session here — every piece of data
 * arrives through the host, either as the initial tool result or via
 * `callServerTool`. Keep this module dependency-free beyond `ext-apps`; it is
 * inlined into every bundle.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import "../tokens.css";

/** The live cubby origin, substituted into the HTML at `resources/read` time. */
function cubbyOrigin(): string | null {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="cubby-origin"]',
  );
  const value = meta?.content;
  // Unsubstituted placeholder means the resource was served by something that
  // didn't run the substitution — degrade to no deep links rather than to a
  // page of broken ones.
  return !value || value.startsWith("__") ? null : value;
}

/**
 * Connect to the host and keep the iframe sized to the content.
 *
 * `setupSizeChangedNotifications` watches the document and notifies the host on
 * every change, so expanding a row reflows the iframe without a manual call.
 */
export async function connectApp(name: string): Promise<App> {
  const app = new App({ name, version: "1.0.0" });
  await app.connect();
  app.setupSizeChangedNotifications();
  return app;
}

/** Open a cubby route in the user's browser, via the host. */
export function openCubby(app: App, path: string): void {
  const origin = cubbyOrigin();
  if (!origin) return;
  void app.openLink({ url: `${origin}${path}` });
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mount(node: Node): void {
  const root = document.getElementById("root");
  if (!root) return;
  root.replaceChildren(node);
}

export function renderError(message: string): void {
  const p = el("p", "empty", message);
  mount(p);
}

/**
 * A tool result's structured payload.
 *
 * Cubby's MCP tools always set `structuredContent` (it's the canonical form;
 * the text block mirrors it), but the JSON text fallback covers a host that
 * forwards only content blocks.
 */
export function toolPayload<T>(result: {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}): T | null {
  if (result.structuredContent) return result.structuredContent as T;
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Round for display without dragging in a formatting library. */
export function num(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}
