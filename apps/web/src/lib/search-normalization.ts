import { TEXT_WHITESPACE, trimText } from "~/lib/text-whitespace";

export const searchWhitespacePattern = `[${TEXT_WHITESPACE}]+`;
const whitespace = new RegExp(searchWhitespacePattern, "g");

/** One normalization recipe, interpreted by strings and repository SQL. */
export const applySearchTextNormalization = <T>(
  text: T,
  operations: {
    trim: (value: T) => T;
    collapseWhitespace: (value: T) => T;
    lowercase: (value: T) => T;
  },
): T =>
  operations.lowercase(operations.collapseWhitespace(operations.trim(text)));

export const normalizeSearchText = (text: string): string =>
  applySearchTextNormalization(text, {
    trim: trimText,
    collapseWhitespace: (value) => value.replace(whitespace, " "),
    lowercase: (value) => value.toLowerCase(),
  });
