import { useEffect, useState } from "react";

/** Hide brief activity and start a new delay after every idle interval. */
export function useDelayedActive(active: boolean) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 300);
    return () => clearTimeout(timer);
  }, [active]);
  return active && visible;
}
