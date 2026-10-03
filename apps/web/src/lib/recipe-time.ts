/**
 * A recipe time for display. The prose string wins whenever it exists — it is
 * verbatim what the source printed ("about 1½ hours, plus overnight chilling"),
 * and re-rendering that from the minute count would both round it and drop the
 * qualifier. The count is the fallback for a time that arrived as a number
 * without prose, and is what the list sorts and filters on.
 */
export const formatRecipeTime = (
  prose: string | null | undefined,
  minutes: number | null | undefined,
): string | null => {
  const trimmed = prose?.trim();
  if (trimmed) return trimmed;
  if (minutes == null) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
};
