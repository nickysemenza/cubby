import { cn } from "~/lib/utils";

/** Literal classes so Tailwind emits every category surface. */
const AVATAR_TONES = [
  "bg-category-1",
  "bg-category-2",
  "bg-category-3",
  "bg-category-4",
  "bg-category-5",
  "bg-category-6",
  "bg-category-7",
  "bg-category-8",
] as const;

/**
 * A stable category slot for a person: the same party keeps its color on
 * every surface and across reloads, independent of list order.
 */
export function avatarToneIndex(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1)
    hash = (Math.imul(hash, 31) + id.charCodeAt(index)) | 0;
  return Math.abs(hash) % AVATAR_TONES.length;
}

/** "Alex Rivera" → "AR"; "Sam" → "SA"; empty → "?". */
export function personInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters =
    words.length === 1
      ? [...(words[0] ?? "")].slice(0, 2)
      : [words[0]?.[0], words.at(-1)?.[0]];
  return letters.join("").toUpperCase();
}

/**
 * A 16px initials disc before a person's name. Decorative: the name beside
 * it is the accessible label.
 */
export function PersonAvatar({
  id,
  name,
  className,
}: {
  id: string;
  name: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-person-avatar={avatarToneIndex(id) + 1}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full text-3xs leading-none font-semibold tracking-tight text-white",
        AVATAR_TONES[avatarToneIndex(id)],
        className,
      )}
    >
      {personInitials(name)}
    </span>
  );
}
