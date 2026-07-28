/**
 * Local host harness for the MCP Apps — a dev tool, not shipped.
 *
 * Drives the real SEP-1865 protocol (AppBridge + PostMessageTransport over a
 * sandboxed iframe), so what renders here is what Claude renders. `pnpm
 * dev:mcp-apps` serves it. Fixtures mirror the tools' real output schemas;
 * update them alongside the schemas, not the apps.
 */
import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import shoppingList from "./fixtures/shopping-list.json";
import usdaPicker from "./fixtures/usda-picker.json";

/**
 * The apps this harness knows how to drive, keyed by bundle name. Each entry
 * carries its own URL rather than having callers interpolate one: building a
 * path out of `<select>.value` reads as a DOM-text-to-URL sink (CodeQL flags
 * it), and an unknown name should fail loudly here rather than 404 in the frame.
 */
const APPS = {
  "shopping-list": { url: "/app/shopping-list.html", fixture: shoppingList },
  "usda-picker": { url: "/app/usda-picker.html", fixture: usdaPicker },
} as const satisfies Record<
  string,
  { url: string; fixture: Record<string, unknown> }
>;

type AppName = keyof typeof APPS;

function isAppName(value: string): value is AppName {
  return Object.hasOwn(APPS, value);
}

const logEl = document.getElementById("log") as HTMLElement;
const frame = document.getElementById("frame") as HTMLIFrameElement;
const pick = document.getElementById("pick") as HTMLSelectElement;

function log(label: string, detail?: unknown) {
  const line = document.createElement("div");
  line.textContent = detail
    ? `${label} ${JSON.stringify(detail).slice(0, 300)}`
    : label;
  logEl.prepend(line);
}

let active: AppBridge | null = null;

async function load(name: AppName) {
  const app = APPS[name];
  logEl.replaceChildren();
  // Each bridge registers a window `message` listener; without closing the
  // previous one every event fires N times and the log stops being trustworthy.
  await active?.close();
  active = null;

  // The bridge must be listening BEFORE the iframe's scripts run: the app posts
  // `ui/initialize` as soon as its module executes, which is before the frame's
  // `load` event. Connecting after that drops the handshake and the app hangs
  // on its splash forever. The WindowProxy survives the srcdoc navigation, so
  // binding the transport to it up front is safe.
  const source = frame.contentWindow;
  if (!source) throw new Error("no iframe window");

  const bridge = new AppBridge(
    null,
    { name: "harness", version: "1.0.0" },
    { openLinks: {}, serverTools: {}, logging: {}, message: {} },
  );

  bridge.oncalltool = async (params) => {
    log("tools/call →", params);
    return { content: [], structuredContent: app.fixture };
  };
  bridge.onopenlink = async (params) => {
    log("ui/open-link →", params);
    return {};
  };
  bridge.onmessage = async (params) => {
    log("ui/message →", params);
    return {};
  };
  bridge.onupdatemodelcontext = async (params) => {
    log("ui/update-model-context →", params);
    return {};
  };
  bridge.onsizechange = (params) => {
    const height = (params as { height?: number }).height;
    if (height) frame.style.height = `${height}px`;
  };
  bridge.oninitialized = () => {
    log("initialized — pushing tool result");
    void bridge.sendToolResult({ content: [], structuredContent: app.fixture });
  };

  bridge.setHostContext({
    theme: "light",
    displayMode: "inline",
    locale: "en-US",
    timeZone: "America/Los_Angeles",
  });

  await bridge.connect(new PostMessageTransport(source, source));
  active = bridge;
  log("bridge connected — loading app");

  frame.src = app.url;
}

function loadSelected() {
  const name = pick.value;
  if (!isAppName(name)) throw new Error(`unknown app: ${name}`);
  void load(name);
}

pick.addEventListener("change", loadSelected);
loadSelected();
