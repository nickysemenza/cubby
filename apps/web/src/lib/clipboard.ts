import { toast } from "sonner";

interface ClipboardNotifications {
  readonly success: (message: string) => void;
  readonly error: (message: string) => void;
}

export interface ClipboardPort {
  readonly writeText: (text: string) => Promise<void>;
  readonly fallbackCopy: (text: string) => boolean;
  readonly notifications: ClipboardNotifications;
}

const copyWithLegacyBrowserCommand = (text: string): boolean => {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
};

const productionClipboardPort: ClipboardPort = {
  writeText: (text) => navigator.clipboard.writeText(text),
  fallbackCopy: copyWithLegacyBrowserCommand,
  notifications: {
    success: toast.success,
    error: toast.error,
  },
};

/**
 * Copy text to the system clipboard, reporting whether it landed.
 *
 * `navigator.clipboard` needs a secure context AND a user gesture, and iOS
 * Safari (the PWA target) is the strictest about both — so a rejection here is
 * an expected path, not an anomaly. The hidden-textarea + `execCommand` ladder
 * is the fallback every browser still honors.
 *
 * Returns rather than toasts: the copy surfaces phrase their own success
 * message ("Copied 12 shortcodes" vs "Copied recipe parse").
 */
export async function copyText(
  text: string,
  port: ClipboardPort = productionClipboardPort,
): Promise<boolean> {
  try {
    await port.writeText(text);
    return true;
  } catch {
    // SILENT: the async Clipboard API needs a secure context + user gesture
    // (iOS Safari is strict about both); a rejection falls through to the
    // execCommand ladder below, whose own return value is what callers see.
  }
  try {
    return port.fallbackCopy(text);
  } catch {
    return false;
  }
}

/**
 * Copy public shortcodes, one per line, and toast the outcome.
 *
 * Newline-delimited to match the table's own range copy (`gridToTsv` joins rows
 * with `\n`), so a column of codes pastes into a spreadsheet — or a prompt — as
 * the list it looks like.
 */
export async function copyShortcodes(
  codes: string[],
  port: ClipboardPort = productionClipboardPort,
): Promise<boolean> {
  if (codes.length === 0) return false;
  const copied = await copyText(codes.join("\n"), port);
  if (!copied) {
    port.notifications.error("Copy failed");
    return false;
  }
  port.notifications.success(
    codes.length === 1 ? `Copied ${codes[0]}` : `Copied ${codes.length} codes`,
  );
  return true;
}

/** Copy external public identifiers for entities that do not use shortcodes. */
export async function copyIdentifiers(
  ids: string[],
  port: ClipboardPort = productionClipboardPort,
): Promise<boolean> {
  if (ids.length === 0) return false;
  const copied = await copyText(ids.join("\n"), port);
  if (!copied) {
    port.notifications.error("Copy failed");
    return false;
  }
  port.notifications.success(
    ids.length === 1 ? `Copied ${ids[0]}` : `Copied ${ids.length} identifiers`,
  );
  return true;
}
