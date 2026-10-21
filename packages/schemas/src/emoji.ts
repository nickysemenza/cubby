import { z } from "zod";

// Built on first use: constructing a Segmenter loads ICU break data, which cost
// ~7 ms of every Worker isolate's startup when this ran at module scope.
let segmenter: Intl.Segmenter | undefined;
/** Emoji identity is one grapheme, including flags, skin tones, keycaps and ZWJ sequences. */
export const recordEmojiInput = z
  .string()
  .refine(
    (value) =>
      value.length <= 64 &&
      [
        ...(segmenter ??= new Intl.Segmenter("en", {
          granularity: "grapheme",
        })).segment(value),
      ].length === 1 &&
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value),
    "Choose one emoji, or clear the field.",
  )
  .nullable();

/** Existing values remain readable; every new write uses recordEmojiInput. */
export const recordEmojiField = {
  key: "emoji",
  kind: "text",
  nullable: true,
  control: {
    kind: "text",
    placeholder: "Choose an emoji",
    suggest: { basis: ["name"] },
  },
  display: { detail: true },
  validation: {
    read: z.string().nullable().optional(),
    create: recordEmojiInput.optional(),
    // Saved legacy text is compared by the kernel before validating a changed identity.
    update: z.string().nullable().optional(),
  },
} as const;

export const emojiCandidates = [
  "🏷️",
  "🥕",
  "🍎",
  "🥦",
  "🍞",
  "🥩",
  "🥛",
  "🍽️",
  "☕",
  "🍳",
  "📦",
  "🏠",
  "🛠️",
  "🔧",
  "🪛",
  "🪚",
  "🧹",
  "🧼",
  "🪴",
  "🌱",
  "🌻",
  "🌳",
  "👕",
  "👟",
  "🧥",
  "🛋️",
  "🛏️",
  "💡",
  "🔌",
  "💻",
  "📱",
  "🎮",
  "📖",
  "🎨",
  "🎵",
  "🚲",
  "🚗",
  "✈️",
  "🎁",
  "🧾",
  "💳",
  "💸",
  "🏦",
  "📅",
  "✅",
  "📍",
  "🏪",
  "🧪",
  "🐾",
  "💊",
  "🏃",
  "🧵",
  "🧺",
  "🗃️",
  "🔁",
  "🤖",
  "🍲",
  "🍝",
  "🍕",
  "🐟",
  "🥚",
  "🧂",
  "🧈",
  "🍋",
  "🫙",
  "🧰",
  "🪑",
  "🖼️",
  "📷",
  "💧",
  "🔥",
  "🧊",
  "♻️",
] as const;
