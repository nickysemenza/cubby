export const mergeNotes = (
  ...notes: readonly (string | null | undefined)[]
): string | null => {
  const texts = [
    ...new Set(
      notes.filter((note): note is string => note != null && note !== ""),
    ),
  ];
  return texts.length ? texts.join("\n\n") : null;
};
