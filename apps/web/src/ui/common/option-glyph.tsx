import type { Icon, IconWeight } from "@phosphor-icons/react/lib";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";

import { EAGER, LAZY } from "./option-glyphs.gen";

/** Every Phosphor name a declaration's option `glyph` may use. */
export const OPTION_GLYPH_NAMES: ReadonlySet<string> = new Set([
  ...EAGER.keys(),
  ...LAZY.keys(),
]);

const loaded = new Map<string, Icon>(EAGER);
const pending = new Map<string, Promise<Icon | null>>();

/** Resolves a glyph once; later renders read the cache synchronously. */
function loadOptionGlyph(name: string): Promise<Icon | null> {
  const ready = loaded.get(name);
  if (ready) return Promise.resolve(ready);
  const inFlight = pending.get(name);
  if (inFlight) return inFlight;
  const loader = LAZY.get(name);
  const promise = loader
    ? loader().then((icon) => {
        loaded.set(name, icon);
        return icon;
      })
    : Promise.resolve(null);
  pending.set(name, promise);
  return promise;
}

function useOptionGlyph(name: string): Icon | null {
  const [icon, setIcon] = useState<Icon | null>(() => loaded.get(name) ?? null);
  const current = loaded.get(name) ?? icon;
  useEffect(() => {
    if (loaded.has(name)) return;
    let live = true;
    void loadOptionGlyph(name).then((next) => {
      if (live) setIcon(() => next);
    });
    return () => {
      live = false;
    };
  }, [name]);
  return current;
}

/**
 * A declared option glyph by Phosphor name. Until a lazy glyph arrives its
 * box is held empty so the chip never reflows; an unknown name renders
 * nothing.
 */
export function OptionGlyph({
  name,
  color,
  weight = "bold",
  className,
  label,
}: {
  name: string;
  /** Tint; omitted, the glyph inherits the surrounding ink. */
  color?: string;
  weight?: IconWeight;
  className?: string;
  /** Spoken name when the glyph stands alone; decorative otherwise. */
  label?: string;
}) {
  const Glyph = useOptionGlyph(name);
  const box = cn("inline-block size-3 shrink-0", className);
  if (!Glyph)
    return OPTION_GLYPH_NAMES.has(name) ? (
      <span aria-hidden data-option-glyph={name} className={box} />
    ) : null;
  return (
    <Glyph
      data-option-glyph={name}
      weight={weight}
      className={box}
      style={color ? { color } : undefined}
      aria-hidden={label ? undefined : true}
      aria-label={label}
    />
  );
}
