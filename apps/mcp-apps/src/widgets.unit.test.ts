import { beforeEach, describe, expect, it, vi } from "vitest";
import shoppingFixture from "../harness/fixtures/shopping-list.json";
import usdaFixture from "../harness/fixtures/usda-picker.json";

type ToolInputNotification = { arguments: Record<string, unknown> };
type ToolResultNotification = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
};

type MockApp = {
  ontoolinput?: (input: ToolInputNotification) => void;
  ontoolresult?: (result: ToolResultNotification) => void;
  connectedWithHandlers: boolean;
  nextToolResult: ToolResultNotification | null;
  callServerTool: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  updateModelContext: ReturnType<typeof vi.fn>;
};

const appState = vi.hoisted(() => ({ instances: [] as MockApp[] }));

vi.mock("@modelcontextprotocol/ext-apps", () => {
  class App {
    ontoolinput?: (input: ToolInputNotification) => void;
    ontoolresult?: (result: ToolResultNotification) => void;
    connectedWithHandlers = false;
    nextToolResult: ToolResultNotification | null = null;
    callServerTool = vi.fn(
      async (_params: {
        name: string;
        arguments?: Record<string, unknown>;
      }) => {
        return (
          this.nextToolResult ?? {
            content: [],
            structuredContent: { items: [], meta: { totalCount: 0 } },
          }
        );
      },
    );
    sendMessage = vi.fn(async () => ({}));
    updateModelContext = vi.fn(async () => ({}));
    openLink = vi.fn(async () => ({}));
    setupSizeChangedNotifications = vi.fn();
    connect = vi.fn(async () => {
      this.connectedWithHandlers = Boolean(
        this.ontoolinput && this.ontoolresult,
      );
    });

    constructor() {
      appState.instances.push(this as MockApp);
    }
  }
  return { App };
});

function result(structuredContent: unknown): ToolResultNotification {
  return { content: [], structuredContent };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function loadWidget(module: "shopping-list" | "usda-picker") {
  document.body.innerHTML = '<div id="root"></div>';
  if (module === "shopping-list") await import("./shopping-list");
  else await import("./usda-picker");
  await flush();
  const app = appState.instances.at(-1);
  if (!app) throw new Error("widget did not construct an App");
  return app;
}

beforeEach(() => {
  vi.resetModules();
  appState.instances.length = 0;
});

describe("USDA picker", () => {
  it("registers host handlers before connect and renders query evidence", async () => {
    const app = await loadWidget("usda-picker");
    expect(app.connectedWithHandlers).toBe(true);

    app.ontoolinput?.({
      arguments: { query: "butter", pageIndex: 0, pageSize: 6 },
    });
    app.ontoolresult?.(result(usdaFixture));

    expect(document.body.textContent).toContain("Searching for “butter”");
    expect(document.body.textContent).toContain("Starts with search");
    expect(document.body.textContent).toContain("Linked");
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(6);
    expect(
      document.querySelector<HTMLButtonElement>(".btn-eyebrow")?.title,
    ).toContain("a higher number is not better");
  });

  it("selects with a radio, commits once, and refines in place", async () => {
    const app = await loadWidget("usda-picker");
    app.ontoolinput?.({ arguments: { query: "butter", pageSize: 6 } });
    app.ontoolresult?.(result(usdaFixture));

    const radio = document.querySelector<HTMLInputElement>(
      'input[type="radio"]',
    );
    if (!radio) throw new Error("missing USDA radio");
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    const use = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Use this");
    use?.click();
    await flush();
    expect(app.updateModelContext).toHaveBeenCalledTimes(1);
    expect(app.sendMessage).toHaveBeenCalledTimes(1);

    const field = document.querySelector<HTMLInputElement>(
      'input[name="query"]',
    );
    const select = document.querySelector<HTMLSelectElement>(
      'select[name="dataType"]',
    );
    const form = document.querySelector<HTMLFormElement>("form");
    if (!field || !select || !form) throw new Error("missing search controls");
    field.value = "salted butter";
    select.value = "foundation_food";
    app.nextToolResult = result({
      meta: { totalCount: 0, pageSize: 6 },
      items: [],
    });
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();

    expect(app.callServerTool).toHaveBeenCalledWith({
      name: "search_usda_foods",
      arguments: {
        query: "salted butter",
        dataType: "foundation_food",
        pageIndex: 0,
        pageSize: 6,
      },
    });
    expect(document.body.textContent).toContain(
      "Searching for “salted butter”",
    );
    expect(document.body.textContent).toContain("No USDA foods matched");
  });
});

describe("shopping list", () => {
  it("shows honest price coverage and disclosed omissions", async () => {
    const app = await loadWidget("shopping-list");
    app.ontoolinput?.({
      arguments: { from: shoppingFixture.from, to: shoppingFixture.to },
    });
    app.ontoolresult?.(result(shoppingFixture));

    expect(document.body.textContent).toContain("$48.00 · priced 6 of 8");
    expect(document.body.textContent).toContain(
      "1 sub-recipe could not be expanded",
    );
    expect(document.body.textContent).toContain("1 meal omitted");
    expect(document.body.textContent).toContain("$28.50");
  });

  it("resets checks for a new result", async () => {
    const app = await loadWidget("shopping-list");
    app.ontoolresult?.(result(shoppingFixture));
    const boxes = [
      ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ];
    boxes[0]?.click();
    expect(boxes[0]?.checked).toBe(true);

    app.ontoolresult?.(result(shoppingFixture));
    expect(
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.checked,
    ).toBe(false);
  });
});
