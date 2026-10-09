import { type ParsedShortcode, parseShortcode } from "@cubby/shared";

interface PastedShortcodeInput {
  currentValue: string;
  pastedText: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

/**
 * Recognize a paste only when the input's resulting value is exactly a
 * shortcode. This avoids turning a shortcode pasted into an ordinary search
 * sentence into an unexpected navigation.
 */
export function parsePastedShortcode({
  currentValue,
  pastedText,
  selectionStart,
  selectionEnd,
}: PastedShortcodeInput): ParsedShortcode | null {
  const start = selectionStart ?? currentValue.length;
  const end = selectionEnd ?? start;
  const pastedValue = `${currentValue.slice(0, start)}${pastedText}${currentValue.slice(end)}`;

  return parseShortcode(pastedValue);
}
