import { useEffect, useRef, useState } from "react";

import type { PhotoGridImage } from "./photo-grid";

export interface PhotoDraftFile {
  key: string;
  file: File;
}

/**
 * Object-URL previews for unsaved file drafts. Keys, rather than array
 * positions, preserve a preview across reorder/removal; every retired URL is
 * revoked once and the remaining URLs are released on unmount.
 */
export function usePhotoDraftPreviews(
  drafts: PhotoDraftFile[],
): PhotoGridImage[] {
  const urlsRef = useRef(new Map<string, string>());
  const [, forceRender] = useState(0);

  useEffect(() => {
    let changed = false;
    const keys = new Set(drafts.map((draft) => draft.key));
    for (const [key, url] of urlsRef.current) {
      if (!keys.has(key)) {
        URL.revokeObjectURL(url);
        urlsRef.current.delete(key);
        changed = true;
      }
    }
    for (const draft of drafts) {
      if (!urlsRef.current.has(draft.key)) {
        urlsRef.current.set(draft.key, URL.createObjectURL(draft.file));
        changed = true;
      }
    }
    if (changed) forceRender((value) => value + 1);
  }, [drafts]);

  useEffect(
    () => () => {
      for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
      urlsRef.current.clear();
    },
    [],
  );

  return drafts.map((draft) => ({
    id: draft.key,
    url: urlsRef.current.get(draft.key) ?? "",
    filename: draft.file.name,
  }));
}
