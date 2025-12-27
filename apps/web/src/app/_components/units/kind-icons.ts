import type { AmountKind } from "@recipehub/recipebridge";
import type { LucideIcon } from "lucide-react";
import {
  DollarSign,
  Flame,
  FlaskConical,
  Ruler,
  Scale,
  Shapes,
  Thermometer,
  Timer,
} from "lucide-react";

export const kindIconMap: Record<
  AmountKind,
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

export function formatKindsLabel(from: AmountKind, to: AmountKind): string {
  return `${kindIconMap[from].label} ↔ ${kindIconMap[to].label}`;
}
