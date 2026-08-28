import { describe, expect, it } from "vitest";

import {
  copyIdentifiers,
  copyShortcodes,
  copyText,
  type ClipboardPort,
} from "./clipboard";

interface ClipboardFakeOptions {
  readonly writeText?: (text: string) => Promise<void>;
  readonly fallbackCopy?: (text: string) => boolean;
}

interface ClipboardFake {
  readonly port: ClipboardPort;
  readonly writes: string[];
  readonly fallbackTexts: string[];
  readonly successMessages: string[];
  readonly errorMessages: string[];
}

function createClipboardFake(
  options: ClipboardFakeOptions = {},
): ClipboardFake {
  const writes: string[] = [];
  const fallbackTexts: string[] = [];
  const successMessages: string[] = [];
  const errorMessages: string[] = [];

  return {
    port: {
      writeText: async (text) => {
        writes.push(text);
        await options.writeText?.(text);
      },
      fallbackCopy: (text) => {
        fallbackTexts.push(text);
        return options.fallbackCopy?.(text) ?? false;
      },
      notifications: {
        success: (message) => successMessages.push(message),
        error: (message) => errorMessages.push(message),
      },
    },
    writes,
    fallbackTexts,
    successMessages,
    errorMessages,
  };
}

describe("copyText", () => {
  it("uses the async clipboard when it resolves", async () => {
    const clipboard = createClipboardFake();

    await expect(copyText("PRD-4K7M", clipboard.port)).resolves.toBe(true);
    expect(clipboard.writes).toEqual(["PRD-4K7M"]);
    expect(clipboard.fallbackTexts).toEqual([]);
  });

  // iOS Safari rejects `writeText` outside a trusted gesture — an expected
  // path, not an anomaly, so the legacy ladder has to carry it.
  it("uses the legacy fallback when the clipboard API rejects", async () => {
    const clipboard = createClipboardFake({
      writeText: async () => {
        throw new Error("denied");
      },
      fallbackCopy: () => true,
    });

    await expect(copyText("LOC-9X2A", clipboard.port)).resolves.toBe(true);
    expect(clipboard.fallbackTexts).toEqual(["LOC-9X2A"]);
  });

  it("reports failure when both paths fail", async () => {
    const clipboard = createClipboardFake({
      writeText: async () => {
        throw new Error("denied");
      },
    });

    await expect(copyText("PRD-4K7M", clipboard.port)).resolves.toBe(false);
  });

  // The fallback can throw rather than return false (older WebKit, and any
  // context where `execCommand` is absent entirely) — a copy button must not
  // take the page down with it.
  it("swallows a throwing fallback instead of rejecting", async () => {
    const clipboard = createClipboardFake({
      writeText: async () => {
        throw new Error("denied");
      },
      fallbackCopy: () => {
        throw new Error("unsupported");
      },
    });

    await expect(copyText("PRD-4K7M", clipboard.port)).resolves.toBe(false);
  });
});

describe("copyShortcodes", () => {
  it("joins codes one per line and names the count", async () => {
    const clipboard = createClipboardFake();

    await expect(
      copyShortcodes(["PRD-4K7M", "PRD-9X2A", "PRD-1B3C"], clipboard.port),
    ).resolves.toBe(true);
    expect(clipboard.writes).toEqual(["PRD-4K7M\nPRD-9X2A\nPRD-1B3C"]);
    expect(clipboard.successMessages).toEqual(["Copied 3 codes"]);
  });

  it("names the code itself when there is only one", async () => {
    const clipboard = createClipboardFake();

    await expect(copyShortcodes(["PRD-4K7M"], clipboard.port)).resolves.toBe(
      true,
    );
    expect(clipboard.successMessages).toEqual(["Copied PRD-4K7M"]);
  });

  it("toasts an error and reports failure when the copy does not land", async () => {
    const clipboard = createClipboardFake({
      writeText: async () => {
        throw new Error("denied");
      },
    });

    await expect(copyShortcodes(["PRD-4K7M"], clipboard.port)).resolves.toBe(
      false,
    );
    expect(clipboard.errorMessages).toEqual(["Copy failed"]);
    expect(clipboard.successMessages).toEqual([]);
  });

  it("is a no-op on an empty selection", async () => {
    const clipboard = createClipboardFake();

    await expect(copyShortcodes([], clipboard.port)).resolves.toBe(false);
    expect(clipboard.writes).toEqual([]);
    expect(clipboard.errorMessages).toEqual([]);
  });
});

describe("copyIdentifiers", () => {
  it("uses identifier language for external public ids", async () => {
    const clipboard = createClipboardFake();

    await expect(
      copyIdentifiers(["12345", "67890"], clipboard.port),
    ).resolves.toBe(true);
    expect(clipboard.writes).toEqual(["12345\n67890"]);
    expect(clipboard.successMessages).toEqual(["Copied 2 identifiers"]);
  });
});
