import type { ReactNode } from "react";

import { Kbd, KbdGroup } from "~/ui/primitives/kbd";

export function KeyHint({
  keys,
  children,
}: {
  keys: string[];
  children: ReactNode;
}) {
  return (
    <span>
      <KbdGroup>
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </KbdGroup>{" "}
      {children}
    </span>
  );
}
