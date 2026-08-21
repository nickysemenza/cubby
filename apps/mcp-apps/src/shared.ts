/**
 * Shared shell and UI kit for the MCP Apps (SEP-1865) bundles.
 *
 * These run in a sandboxed iframe with no cookies and no access to the parent
 * page, so there is no tRPC and no cubby session here — every piece of data
 * arrives through the host, either as the initial tool result or via
 * `callServerTool`.
 *
 * Keep this dependency-free beyond `ext-apps`; it is inlined into every bundle.
 * Styling lives in `app.css` as classes — prefer adding one there over an inline
 * style, so the apps stay consistent with each other and with the web app.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import "./app.css";
// From the leaf module, never from `./bundles` — that one glob-imports every
// built bundle, and reaching it from an app makes each build inline the
// previous build's output into itself.
import { readCubbyOrigin } from "./origin";

export function openCubby(app: App, path: string): void {
  const origin = readCubbyOrigin(document);
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

function button(
  className: string,
  label: string,
  onClick: (event: MouseEvent) => void,
): HTMLButtonElement {
  const node = el("button", className, label);
  node.addEventListener("click", onClick);
  return node;
}

/**
 * A button inside a clickable row or card: stops the click from also triggering
 * the container's own handler.
 */
export function nestedButton(
  className: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  return button(className, label, (event) => {
    event.stopPropagation();
    onClick();
  });
}

export function panel(title: string, meta: string): HTMLElement {
  const root = el("div", "panel");
  const head = el("div", "panel-head");
  head.append(el("h2", undefined, title), el("span", "eyebrow", meta));
  root.append(head);
  return root;
}

export function footer(...children: Node[]): HTMLElement {
  const root = el("div", "footer");
  root.append(...children);
  return root;
}

export function cubbyLink(
  app: App,
  label: string,
  path: string,
): HTMLButtonElement {
  return button("btn-quiet", label, () => openCubby(app, path));
}

/**
 * A tool result's structured payload.
 *
 * Cubby's MCP tools always set `structuredContent` (it's canonical; the text
 * block mirrors it), but the JSON text fallback covers a host that forwards
 * only content blocks.
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

/**
 * Connect to the host, then render every tool result it pushes.
 *
 * `setupSizeChangedNotifications` watches the document and notifies the host on
 * each change, so expanding a row reflows the iframe with no manual call.
 * `render` gets the parsed payload and returns the tree to mount; a payload that
 * won't parse shows `invalid` instead. `onResult` runs first, for state an app
 * needs to reset between results.
 */
export async function bootstrap<
  TPayload,
  TInput extends Record<string, unknown> = Record<string, unknown>,
>(options: {
  name: string;
  invalid: string;
  render: (app: App, payload: TPayload, input: TInput | null) => Node;
  onResult?: (app: App, payload: TPayload, input: TInput | null) => void;
}): Promise<void> {
  const app = new App({ name: options.name, version: "1.0.0" });
  let input: TInput | null = null;
  let payload: TPayload | null = null;

  const mount = () => {
    if (!payload) return;
    const root = document.getElementById("root");
    if (!root) return;
    root.replaceChildren(options.render(app, payload, input));
  };

  // The host is allowed to deliver one-shot input/result notifications as soon
  // as initialization completes. Install both handlers before connect so a
  // fast host cannot race past them.
  app.ontoolinput = (notification) => {
    input = notification.arguments as TInput;
    mount();
  };

  app.ontoolresult = (result) => {
    const nextPayload = toolPayload<TPayload>(result);
    const root = document.getElementById("root");
    if (!root) return;
    if (!nextPayload) {
      root.replaceChildren(el("p", "empty", options.invalid));
      return;
    }
    payload = nextPayload;
    options.onResult?.(app, nextPayload, input);
    mount();
  };

  await app.connect();
  app.setupSizeChangedNotifications();
}

/** Round for display without dragging in a formatting library. */
export function num(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

/** `3 meals` / `1 meal` — a count plus a correctly-inflected noun. */
export function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
