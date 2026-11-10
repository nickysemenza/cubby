import { useEffect, useRef, useState } from "react";

/**
 * The live text of a rendered value, for an accessible or button label: a
 * reference resolves its name asynchronously, so this follows the DOM.
 */
export function useRenderedText() {
  const ref = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => setText(element.textContent?.trim() ?? "");
    read();
    const observer = new MutationObserver(read);
    observer.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, []);
  return { ref, text };
}
