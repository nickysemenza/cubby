import { CalendarDotsIcon } from "@phosphor-icons/react/dist/csr/CalendarDots";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleDashedIcon } from "@phosphor-icons/react/dist/csr/CircleDashed";
import { CircleHalfIcon } from "@phosphor-icons/react/dist/csr/CircleHalf";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { HourglassIcon } from "@phosphor-icons/react/dist/csr/Hourglass";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { PauseCircleIcon } from "@phosphor-icons/react/dist/csr/PauseCircle";
import { ProhibitIcon } from "@phosphor-icons/react/dist/csr/Prohibit";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import type { Icon, IconWeight } from "@phosphor-icons/react/lib";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";

/**
 * Status glyphs ship with the bundle: every list paints them on first render,
 * and the shared palette infers them for every status roster.
 */
const EAGER = new Map<string, Icon>(
  Object.entries({
    CalendarDots: CalendarDotsIcon,
    Check: CheckIcon,
    CheckCircle: CheckCircleIcon,
    CircleDashed: CircleDashedIcon,
    CircleHalf: CircleHalfIcon,
    Clock: ClockIcon,
    Hourglass: HourglassIcon,
    Minus: MinusIcon,
    PauseCircle: PauseCircleIcon,
    Prohibit: ProhibitIcon,
    XCircle: XCircleIcon,
  }),
);

/**
 * Declared category glyphs load on first use, one small chunk each. Static
 * `import()` paths keep the bundler from pulling the whole Phosphor set; a
 * declaration naming a glyph missing here is caught by the manifest test.
 */
const LAZY = new Map<string, () => Promise<Icon>>(
  Object.entries({
    AirplaneTilt: () =>
      import("@phosphor-icons/react/dist/csr/AirplaneTilt").then(
        (m) => m.AirplaneTiltIcon,
      ),
    Archive: () =>
      import("@phosphor-icons/react/dist/csr/Archive").then(
        (m) => m.ArchiveIcon,
      ),
    BookOpen: () =>
      import("@phosphor-icons/react/dist/csr/BookOpen").then(
        (m) => m.BookOpenIcon,
      ),
    Car: () =>
      import("@phosphor-icons/react/dist/csr/Car").then((m) => m.CarIcon),
    ClipboardText: () =>
      import("@phosphor-icons/react/dist/csr/ClipboardText").then(
        (m) => m.ClipboardTextIcon,
      ),
    Couch: () =>
      import("@phosphor-icons/react/dist/csr/Couch").then((m) => m.CouchIcon),
    Cpu: () =>
      import("@phosphor-icons/react/dist/csr/Cpu").then((m) => m.CpuIcon),
    Cube: () =>
      import("@phosphor-icons/react/dist/csr/Cube").then((m) => m.CubeIcon),
    Disc: () =>
      import("@phosphor-icons/react/dist/csr/Disc").then((m) => m.DiscIcon),
    Drop: () =>
      import("@phosphor-icons/react/dist/csr/Drop").then((m) => m.DropIcon),
    Fan: () =>
      import("@phosphor-icons/react/dist/csr/Fan").then((m) => m.FanIcon),
    FileArchive: () =>
      import("@phosphor-icons/react/dist/csr/FileArchive").then(
        (m) => m.FileArchiveIcon,
      ),
    Flower: () =>
      import("@phosphor-icons/react/dist/csr/Flower").then((m) => m.FlowerIcon),
    ForkKnife: () =>
      import("@phosphor-icons/react/dist/csr/ForkKnife").then(
        (m) => m.ForkKnifeIcon,
      ),
    Gear: () =>
      import("@phosphor-icons/react/dist/csr/Gear").then((m) => m.GearIcon),
    GridNine: () =>
      import("@phosphor-icons/react/dist/csr/GridNine").then(
        (m) => m.GridNineIcon,
      ),
    Hammer: () =>
      import("@phosphor-icons/react/dist/csr/Hammer").then((m) => m.HammerIcon),
    House: () =>
      import("@phosphor-icons/react/dist/csr/House").then((m) => m.HouseIcon),
    Lightning: () =>
      import("@phosphor-icons/react/dist/csr/Lightning").then(
        (m) => m.LightningIcon,
      ),
    Oven: () =>
      import("@phosphor-icons/react/dist/csr/Oven").then((m) => m.OvenIcon),
    Package: () =>
      import("@phosphor-icons/react/dist/csr/Package").then(
        (m) => m.PackageIcon,
      ),
    PaintRoller: () =>
      import("@phosphor-icons/react/dist/csr/PaintRoller").then(
        (m) => m.PaintRollerIcon,
      ),
    Palette: () =>
      import("@phosphor-icons/react/dist/csr/Palette").then(
        (m) => m.PaletteIcon,
      ),
    Plant: () =>
      import("@phosphor-icons/react/dist/csr/Plant").then((m) => m.PlantIcon),
    Rectangle: () =>
      import("@phosphor-icons/react/dist/csr/Rectangle").then(
        (m) => m.RectangleIcon,
      ),
    Ruler: () =>
      import("@phosphor-icons/react/dist/csr/Ruler").then((m) => m.RulerIcon),
    Shapes: () =>
      import("@phosphor-icons/react/dist/csr/Shapes").then((m) => m.ShapesIcon),
    ShoppingBag: () =>
      import("@phosphor-icons/react/dist/csr/ShoppingBag").then(
        (m) => m.ShoppingBagIcon,
      ),
    ShoppingCart: () =>
      import("@phosphor-icons/react/dist/csr/ShoppingCart").then(
        (m) => m.ShoppingCartIcon,
      ),
    Sparkle: () =>
      import("@phosphor-icons/react/dist/csr/Sparkle").then(
        (m) => m.SparkleIcon,
      ),
    Square: () =>
      import("@phosphor-icons/react/dist/csr/Square").then((m) => m.SquareIcon),
    SquaresFour: () =>
      import("@phosphor-icons/react/dist/csr/SquaresFour").then(
        (m) => m.SquaresFourIcon,
      ),
    Stack: () =>
      import("@phosphor-icons/react/dist/csr/Stack").then((m) => m.StackIcon),
    TShirt: () =>
      import("@phosphor-icons/react/dist/csr/TShirt").then((m) => m.TShirtIcon),
    Table: () =>
      import("@phosphor-icons/react/dist/csr/Table").then((m) => m.TableIcon),
    Trash: () =>
      import("@phosphor-icons/react/dist/csr/Trash").then((m) => m.TrashIcon),
    Tree: () =>
      import("@phosphor-icons/react/dist/csr/Tree").then((m) => m.TreeIcon),
    Truck: () =>
      import("@phosphor-icons/react/dist/csr/Truck").then((m) => m.TruckIcon),
    Wrench: () =>
      import("@phosphor-icons/react/dist/csr/Wrench").then((m) => m.WrenchIcon),
  }),
);

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
