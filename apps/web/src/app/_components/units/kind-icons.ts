import type { AmountKind } from "@cubby/recipebridge";
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
