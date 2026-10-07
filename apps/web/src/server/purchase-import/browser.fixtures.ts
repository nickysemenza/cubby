import {
  BROWSER_BRIDGE_PROTOCOL,
  type BrowserBridgeRequest,
  type BrowserBridgeResult,
  type BrowserObservation,
  type BrowserPageCapture,
} from "@cubby/schemas/purchase-import";

import { encodeSnapshotDom } from "./browser-page";
import type { BrowserEvidenceStorage } from "./browser-results";
import type { BrowserPagePorts } from "./run-service";

/** Synthetic Mac results for tests: real v3 snapshots of rendered HTML. */

type Outcome = BrowserBridgeResult["outcome"];
type FailedOutcome = Extract<Outcome, { status: "failed" }>;

export function observation(
  overrides: Partial<BrowserObservation> = {},
): BrowserObservation {
  return {
    url: null,
    title: null,
    readyState: "complete",
    window: { recovered: false, minimized: false, onScreen: true },
    screenRecording: "granted",
    durationMs: 250,
    ...overrides,
  };
}

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export interface SyntheticPage {
  title: string;
  /** Lines of visible text, one paragraph each. */
  text?: string;
  links?: ReadonlyArray<{ url: string; label?: string | null }>;
  images?: ReadonlyArray<{
    url: string;
    alt?: string | null;
    width?: number | null;
    height?: number | null;
  }>;
  canonicalUrl?: string | null;
  jsonLd?: readonly unknown[];
  signIn?: boolean;
}

/** HTML the server's page derivation reads back as the given page. */
export function renderPage(page: SyntheticPage): string {
  const head = [
    `<title>${escape(page.title)}</title>`,
    page.canonicalUrl
      ? `<link rel="canonical" href="${escape(page.canonicalUrl)}">`
      : "",
    ...(page.jsonLd ?? []).map(
      (block) =>
        `<script type="application/ld+json">${JSON.stringify(block)}</script>`,
    ),
  ];
  const body = [
    ...(page.text ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => `<p>${escape(line)}</p>`),
    ...(page.links ?? []).map(
      (link) =>
        `<p><a href="${escape(link.url)}">${escape(link.label ?? "")}</a></p>`,
    ),
    ...(page.images ?? []).map(
      (image) =>
        `<img src="${escape(image.url)}" alt="${escape(image.alt ?? "")}"${image.width ? ` width="${image.width}"` : ""}${image.height ? ` height="${image.height}"` : ""}>`,
    ),
    page.signIn ? '<form><input type="password"></form>' : "",
  ];
  return `<!doctype html><html><head>${head.join("")}</head><body>${body.join("")}</body></html>`;
}

/** A completed capture of raw `html`, as the Mac would send it. */
async function capturedHtml(input: {
  sourceURL: string;
  title: string;
  html: string;
  screenshot?: BrowserPageCapture["evidence"];
}): Promise<Outcome> {
  const screenshot = input.screenshot ?? [];
  return {
    status: "completed",
    snapshot: {
      sourceURL: input.sourceURL,
      title: input.title,
      capturedAt: new Date().toISOString(),
      dom: await encodeSnapshotDom(input.html),
      screenshot: screenshot.length
        ? { status: "captured", evidence: [...screenshot] }
        : { status: "skipped" },
    },
    observation: observation({ url: input.sourceURL, title: input.title }),
  };
}

/** A completed capture of a synthetic `page` at `sourceURL`. */
export const completedCapture = (
  sourceURL: string,
  page: SyntheticPage,
  screenshot: BrowserPageCapture["evidence"] = [],
) =>
  capturedHtml({
    sourceURL,
    title: page.title,
    html: renderPage(page),
    screenshot,
  });

export function failedCommand(
  code: FailedOutcome["code"],
  overrides: Partial<Omit<FailedOutcome, "status" | "code">> = {},
): FailedOutcome {
  return {
    status: "failed",
    code,
    message: `synthetic ${code}`,
    retryable: false,
    screenshotGap: null,
    observation: observation(),
    ...overrides,
  };
}

/** Evidence storage that keeps objects in memory (R2 is out of reach). */
function memoryEvidenceStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const storage: BrowserEvidenceStorage = {
    put: async (key, bytes, contentType) => {
      objects.set(key, { bytes, contentType });
    },
  };
  return { storage, objects };
}

/** Ports for tests: in-memory evidence and a server that is always refused. */
export function testBrowserPorts(
  fetchPage: BrowserPagePorts["fetchPage"] = async () => ({
    status: "blocked",
    reason: "synthetic refusal",
    durationMs: 1,
  }),
): BrowserPagePorts & { objects: Map<string, unknown> } {
  const { storage, objects } = memoryEvidenceStorage();
  return { storage, fetchPage, objects };
}

/**
 * A fake per-account bridge. `respond` answers each issued command (by its
 * position in issue order); null leaves it pending.
 */
export function scriptedBroker(
  respond: (
    command: BrowserBridgeRequest,
    index: number,
  ) => Outcome | null | Promise<Outcome | null>,
) {
  const issued: BrowserBridgeRequest[] = [];
  const authenticationRequests: string[] = [];
  const broker = {
    enqueue: async (command: BrowserBridgeRequest) => {
      if (!issued.some((known) => known.id === command.id))
        issued.push(command);
    },
    result: async (commandId: string): Promise<BrowserBridgeResult | null> => {
      const index = issued.findIndex((command) => command.id === commandId);
      const command = issued[index];
      if (!command) return null;
      const outcome = await respond(command, index);
      return outcome
        ? {
            protocolVersion: BROWSER_BRIDGE_PROTOCOL,
            commandID: command.id,
            operationID: command.operationId,
            runID: command.runID,
            completedAt: new Date().toISOString(),
            outcome,
          }
        : null;
    },
    cancel: async () => undefined,
    connected: async () => true,
    pendingCommands: async () => [],
    notifyRunCompleted: async () => undefined,
    requestAuthentication: async (runId: string) => {
      authenticationRequests.push(runId);
    },
  };
  return {
    namespace: { getByName: () => broker },
    issued,
    authenticationRequests,
  };
}
