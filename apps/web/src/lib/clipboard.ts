import { toast } from "sonner";

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
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
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
export async function copyShortcodes(codes: string[]): Promise<boolean> {
  if (codes.length === 0) return false;
  const copied = await copyText(codes.join("\n"));
  if (!copied) {
    toast.error("Copy failed");
    return false;
  }
  toast.success(
    codes.length === 1 ? `Copied ${codes[0]}` : `Copied ${codes.length} codes`,
  );
  return true;
}

/** Copy external public identifiers for entities that do not use shortcodes. */
export async function copyIdentifiers(ids: string[]): Promise<boolean> {
  if (ids.length === 0) return false;
  const copied = await copyText(ids.join("\n"));
  if (!copied) {
    toast.error("Copy failed");
    return false;
  }
  toast.success(
    ids.length === 1 ? `Copied ${ids[0]}` : `Copied ${ids.length} identifiers`,
  );
  return true;
}
