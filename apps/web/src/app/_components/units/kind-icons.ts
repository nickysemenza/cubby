import type { AmountKind } from "@cubby/recipebridge";
import type { LucideIcon } from "lucide-react";
import {
  DollarSign,
  Flame,
  FlaskConical,
  Ruler,
  Scale,
  Shapes as OtherKindIcon,
  Thermometer,
  Timer,
} from "lucide-react";

const kindIconMap = {
  weight: { Icon: Scale, label: "Weight" },
  volume: { Icon: FlaskConical, label: "Volume" },
  money: { Icon: DollarSign, label: "Money" },
  calories: { Icon: Flame, label: "Calories" },
  time: { Icon: Timer, label: "Time" },
  temperature: { Icon: Thermometer, label: "Temperature" },
  length: { Icon: Ruler, label: "Length" },
  other: { Icon: OtherKindIcon, label: "Other" },
} satisfies Record<AmountKind, { Icon: LucideIcon; label: string }>;

export function kindIconFor(kind: AmountKind) {
  switch (kind) {
    case "weight":
    case "volume":
    case "money":
    case "calories":
    case "time":
    case "temperature":
    case "length":
      return kindIconMap[kind];
    default:
      return kindIconMap.other;
  }
}
