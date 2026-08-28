import { beforeEach, describe, expect, it, vi } from "vitest";
import usdaFixture from "../harness/fixtures/usda-picker.json";
import { connectUsdaPicker, type UsdaPickerApp } from "./usda-picker";

type ToolResultNotification = Parameters<
  NonNullable<UsdaPickerApp["ontoolresult"]>
>[0];

class TestUsdaPickerApp implements UsdaPickerApp {
  ontoolinput: UsdaPickerApp["ontoolinput"];
  ontoolresult: UsdaPickerApp["ontoolresult"];
  connectedWithHandlers = false;
  nextToolResult: ToolResultNotification | null = null;
  callServerTool = vi.fn<UsdaPickerApp["callServerTool"]>(async () => {
    return (
      this.nextToolResult ?? {
        content: [],
        structuredContent: { items: [], meta: { totalCount: 0 } },
      }
    );
  });
  sendMessage = vi.fn<UsdaPickerApp["sendMessage"]>(async () => ({}));
  updateModelContext = vi.fn<UsdaPickerApp["updateModelContext"]>(
    async () => ({}),
  );
  openLink = vi.fn<UsdaPickerApp["openLink"]>(async () => ({}));
  setupSizeChangedNotifications =
    vi.fn<UsdaPickerApp["setupSizeChangedNotifications"]>();
  connect = vi.fn<UsdaPickerApp["connect"]>(async () => {
    this.connectedWithHandlers = Boolean(this.ontoolinput && this.ontoolresult);
  });
}

function result(
  structuredContent: ToolResultNotification["structuredContent"],
): ToolResultNotification {
  return { content: [], structuredContent };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function loadWidget() {
  document.body.innerHTML = '<div id="root"></div>';
  const app = new TestUsdaPickerApp();
  await connectUsdaPicker(app);
  await flush();
  return app;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("USDA picker", () => {
  it("registers host handlers before connect and renders query evidence", async () => {
    const app = await loadWidget();
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
    const app = await loadWidget();
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

  it("rejects malformed structured and text tool payloads", async () => {
    const app = await loadWidget();
    app.ontoolresult?.({
      structuredContent: { items: [{ fdc_id: "not-a-number" }] },
      content: [{ type: "text", text: JSON.stringify({ items: "invalid" }) }],
    });

    expect(document.body.textContent).toContain(
      "Could not read USDA results from the tool result.",
    );
  });

  it("drops malformed tool input at the host boundary", async () => {
    const app = await loadWidget();
    app.ontoolinput?.({ arguments: { query: 42 } });
    app.ontoolresult?.(result(usdaFixture));

    expect(document.body.textContent).toContain("Search USDA foods");
    expect(document.body.textContent).not.toContain("Searching for “42”");
  });
});
