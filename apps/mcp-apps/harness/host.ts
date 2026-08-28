/**
 * Local host harness for the MCP Apps — a dev tool, not shipped.
 *
 * Drives the real SEP-1865 protocol (AppBridge + PostMessageTransport over a
 * sandboxed iframe), so what renders here is what Claude renders. `pnpm
 * --filter @cubby/mcp-apps dev` serves it.
 */
import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import usdaPicker from "./fixtures/usda-picker.json";

const app = {
  url: "/app/usda-picker.html",
  fixture: usdaPicker,
  input: { query: "butter", pageIndex: 0, pageSize: 6 },
};

const logEl = document.getElementById("log") as HTMLElement;
const frame = document.getElementById("frame") as HTMLIFrameElement;

function log(label: string, detail?: unknown) {
  const line = document.createElement("div");
  line.textContent = detail
    ? `${label} ${JSON.stringify(detail).slice(0, 300)}`
    : label;
  logEl.prepend(line);
}

let active: AppBridge | null = null;

async function load() {
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
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- AppBridge exposes protocol callback slots rather than DOM events.
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
  bridge.oninitialized = async () => {
    await bridge.setHostContext({
      theme: "light",
      displayMode: "inline",
      locale: "en-US",
      timeZone: "America/Los_Angeles",
    });
    log("initialized — pushing tool input and result", app.input);
    await bridge.sendToolInput({ arguments: app.input });
    await bridge.sendToolResult({
      content: [],
      structuredContent: app.fixture,
    });
  };

  await bridge.connect(new PostMessageTransport(source, source));
  active = bridge;
  log("bridge connected — loading app");

  frame.src = app.url;
}

void load();
