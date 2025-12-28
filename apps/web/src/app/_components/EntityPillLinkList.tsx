import type React from "react";
import { NoneState } from "./NoneState";

interface EntityPillLinkListProps<T, P extends { [K in keyof P]: unknown }> {
  items?: T[];
  Pill: React.ComponentType<P>;
  pillPropName: keyof P;
  getKey?: (item: T) => string | number;
  minimal?: boolean;
}

export function EntityPillLinkList<T, P extends { [K in keyof P]: unknown }>({
  items,
  Pill,
  pillPropName,
  getKey,
  minimal,
}: EntityPillLinkListProps<T, P>) {
  if (!items || items.length === 0) {
    return <NoneState />;
  }

  return (
    <div className="space-y-0.5">
      {items.map((item, index) => (
        <div key={getKey ? getKey(item) : index}>
          <Pill {...({ [pillPropName]: item, minimal } as P)} />
        </div>
      ))}
    </div>
  );
}
