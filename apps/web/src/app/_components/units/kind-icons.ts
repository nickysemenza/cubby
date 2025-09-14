import { type LucideIcon } from "lucide-react";
import {
  DollarSign,
  FlaskConical,
  Flame,
  Scale,
  Thermometer,
  Timer,
  Ruler,
  Shapes,
} from "lucide-react";
import { type MeasureKind } from "wasm/recipebridge";

export const kindIconMap: Record<
  MeasureKind,
  { Icon: LucideIcon; label: string }
> = {
  weight: { Icon: Scale, label: "Weight" },
  volume: { Icon: FlaskConical, label: "Volume" },
  money: { Icon: DollarSign, label: "Money" },
  calories: { Icon: Flame, label: "Calories" },
  time: { Icon: Timer, label: "Time" },
  temperature: { Icon: Thermometer, label: "Temperature" },
  length: { Icon: Ruler, label: "Length" },
  other: { Icon: Shapes, label: "Other" },
};

export function formatKindsLabel(from: MeasureKind, to: MeasureKind): string {
  return `${kindIconMap[from].label} ↔ ${kindIconMap[to].label}`;
}
