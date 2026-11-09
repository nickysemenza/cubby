import { useCallback, useEffect, useRef, useState } from "react";

export function useCopiedFlag(resetAfter: number | null = 1500) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const markCopied = useCallback(
    (success = true) => {
      clearTimeout(timer.current);
      setCopied(success);
      if (success && resetAfter !== null) {
        timer.current = setTimeout(() => setCopied(false), resetAfter);
      }
    },
    [resetAfter],
  );
  return [copied, markCopied] as const;
}
