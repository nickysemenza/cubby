import { useMemo } from "react";

export type Section<T> = {
  title: string;
  data: T[];
};

/**
 * Groups flat data into SectionList-compatible sections.
 * Sorts sections alphabetically, putting "(unspecified)" last.
 */
export function useGroupedList<T>(
  data: T[],
  keyFn: (item: T) => string | null | undefined,
): Section<T>[] {
  return useMemo(() => {
    const groups = new Map<string, T[]>();

    for (const item of data) {
      const key = keyFn(item) || "(unspecified)";
      const existing = groups.get(key);
      if (existing) {
        existing.push(item);
      } else {
        groups.set(key, [item]);
      }
    }

    const sections: Section<T>[] = [];
    for (const [title, items] of groups) {
      sections.push({ title, data: items });
    }

    sections.sort((a, b) => {
      if (a.title === "(unspecified)") return 1;
      if (b.title === "(unspecified)") return -1;
      return a.title.localeCompare(b.title);
    });

    return sections;
  }, [data, keyFn]);
}
