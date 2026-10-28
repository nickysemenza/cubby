import { createContext, type ReactNode, useEffect, useRef } from "react";

export const ValueChangeScope = createContext("");

/** A caller supplies the identity and the displayed semantic value, excluding metadata. */
export type ValueChange = {
  identity: string;
  value: string | number | boolean | null | undefined;
};

/** Remounts establish a quiet baseline; only changes observed while mounted flash. */
export function ChangedValue({
  change,
  children,
}: {
  change?: ValueChange;
  children: ReactNode;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const baseline = useRef<{ change: ValueChange; text: string } | undefined>(
    undefined,
  );
  const animation = useRef<Animation | undefined>(undefined);
  useEffect(() => {
    const text = element.current?.textContent ?? "";
    const previous = baseline.current;
    baseline.current = change ? { change, text } : undefined;
    if (!change || !previous || previous.change.identity !== change.identity) {
      animation.current?.cancel();
      return;
    }
    if (
      Object.is(previous.change.value, change.value) ||
      previous.text === text
    )
      return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    animation.current?.cancel();
    animation.current = element.current?.animate?.(
      [
        { backgroundColor: "var(--brand-info-surface)", offset: 0 },
        { backgroundColor: "var(--brand-info-surface)", offset: 0.75 },
        { backgroundColor: "transparent", offset: 1 },
      ],
      { duration: 2000, easing: "ease-out" },
    );
  });
  useEffect(() => () => animation.current?.cancel(), []);
  return (
    <span ref={element} className="rounded-sm">
      {children}
    </span>
  );
}
