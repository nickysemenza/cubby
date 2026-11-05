import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import type { ReactNode } from "react";

import { Button } from "~/ui/primitives/button";

type Step = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  shortcut?: string;
};
export function PrevNextButtons({
  previous,
  next,
  children,
  compact = false,
}: {
  previous: Step;
  next: Step;
  children?: ReactNode;
  compact?: boolean;
}) {
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={compact ? "icon-xs" : "icon-sm"}
        mobileSize={compact ? "compact" : "touch"}
        aria-label={previous.label}
        aria-keyshortcuts={previous.shortcut}
        title={
          previous.shortcut
            ? `${previous.label} (${previous.shortcut})`
            : undefined
        }
        disabled={previous.disabled}
        onClick={previous.onClick}
      >
        <CaretLeftIcon aria-hidden />
      </Button>
      {children}
      <Button
        type="button"
        variant="outline"
        size={compact ? "icon-xs" : "icon-sm"}
        mobileSize={compact ? "compact" : "touch"}
        aria-label={next.label}
        aria-keyshortcuts={next.shortcut}
        title={next.shortcut ? `${next.label} (${next.shortcut})` : undefined}
        disabled={next.disabled}
        onClick={next.onClick}
      >
        <CaretRightIcon aria-hidden />
      </Button>
    </>
  );
}
