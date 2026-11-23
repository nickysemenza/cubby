import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Inside a closed ledger row the body has no box, so it can never scroll into
 * view: the row mounts it at once instead, so its count and digest report.
 */
export const EagerContentContext = createContext(false);

/** Admit a lower section once, then keep editors mounted when it scrolls away. */
export function VisibleContent({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  const eager = useContext(EagerContentContext);
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  useEffect(() => {
    const element = host.current;
    if (!element || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  return <div ref={host}>{visible || eager ? children : fallback}</div>;
}
