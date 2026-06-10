import { Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const STORAGE_KEY = "cubby-theme";

/**
 * Light/dark theme state. The root document's inline script applies the
 * stored (or system) preference pre-paint; this hook reads the resulting
 * class after mount, so SSR and the first client render agree (no mismatch).
 */
export function useTheme() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      document.documentElement.classList.toggle("dark", next);
      try {
        localStorage.setItem(STORAGE_KEY, next ? "dark" : "light");
      } catch {
        // Private mode etc. — the toggle still works for this session.
      }
      return next;
    });
  }, []);

  return { isDark, toggle };
}

export function ThemeToggleButton({ className }: { className?: string }) {
  const { isDark, toggle } = useTheme();

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      className={cn("h-8 px-2", className)}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
