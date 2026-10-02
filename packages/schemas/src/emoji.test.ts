import { describe, expect, it } from "vitest";
import { recordEmojiInput } from "./emoji";

// Compound Unicode sequences must remain intact; text and multiple marks must not become record identity.
describe("record emoji input", () => {
  it.each(["🥕", "👩🏽‍🍳", "🇺🇸", "1️⃣", "🏳️‍🌈"])(
    "accepts one emoji grapheme: %s",
    (value) => {
      expect(recordEmojiInput.parse(value)).toBe(value);
    },
  );
  it.each(["food", "🥕🥦", "a🥕", "\n🥕\n", "\u200b🥕"])(
    "rejects non-identity input: %s",
    (value) => {
      expect(recordEmojiInput.safeParse(value).success).toBe(false);
    },
  );
  it("uses null to clear the mark", () => {
    expect(recordEmojiInput.parse(null)).toBeNull();
  });
});
