import type { AmountKind } from "@cubby/recipebridge";
import { CurrencyDollarIcon } from "@phosphor-icons/react/dist/csr/CurrencyDollar";
import { FlameIcon } from "@phosphor-icons/react/dist/csr/Flame";
import { FlaskIcon } from "@phosphor-icons/react/dist/csr/Flask";
import { RulerIcon } from "@phosphor-icons/react/dist/csr/Ruler";
import { ScalesIcon } from "@phosphor-icons/react/dist/csr/Scales";
import { ShapesIcon } from "@phosphor-icons/react/dist/csr/Shapes";
import { ThermometerIcon } from "@phosphor-icons/react/dist/csr/Thermometer";
import { TimerIcon } from "@phosphor-icons/react/dist/csr/Timer";
import type { Icon } from "@phosphor-icons/react/lib";

const kindIconMap = {
  weight: { Icon: ScalesIcon, label: "Weight" },
  volume: { Icon: FlaskIcon, label: "Volume" },
  money: { Icon: CurrencyDollarIcon, label: "Money" },
  calories: { Icon: FlameIcon, label: "Calories" },
  time: { Icon: TimerIcon, label: "Time" },
  temperature: { Icon: ThermometerIcon, label: "Temperature" },
  length: { Icon: RulerIcon, label: "Length" },
  other: { Icon: ShapesIcon, label: "Other" },
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
