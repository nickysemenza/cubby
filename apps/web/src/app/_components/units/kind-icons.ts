import type { AmountKind } from "@cubby/recipebridge";
import { CurrencyDollarIcon as DollarSign } from "@phosphor-icons/react/dist/csr/CurrencyDollar";
import { FlameIcon as Flame } from "@phosphor-icons/react/dist/csr/Flame";
import { FlaskIcon as FlaskConical } from "@phosphor-icons/react/dist/csr/Flask";
import { RulerIcon as Ruler } from "@phosphor-icons/react/dist/csr/Ruler";
import { ScalesIcon as Scale } from "@phosphor-icons/react/dist/csr/Scales";
import { ShapesIcon as OtherKindIcon } from "@phosphor-icons/react/dist/csr/Shapes";
import { ThermometerIcon as Thermometer } from "@phosphor-icons/react/dist/csr/Thermometer";
import { TimerIcon as Timer } from "@phosphor-icons/react/dist/csr/Timer";
import type { Icon } from "@phosphor-icons/react/lib";

const kindIconMap = {
  weight: { Icon: Scale, label: "Weight" },
  volume: { Icon: FlaskConical, label: "Volume" },
  money: { Icon: DollarSign, label: "Money" },
  calories: { Icon: Flame, label: "Calories" },
  time: { Icon: Timer, label: "Time" },
  temperature: { Icon: Thermometer, label: "Temperature" },
  length: { Icon: Ruler, label: "Length" },
  other: { Icon: OtherKindIcon, label: "Other" },
} satisfies Record<AmountKind, { Icon: Icon; label: string }>;

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
