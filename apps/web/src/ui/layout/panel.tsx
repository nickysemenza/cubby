import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/** `muted` and `warning` carry meaning; they are not decoration choices. */
type PanelTone = "default" | "muted" | "warning";

const TONE_CLASS = {
  default: "border border-border bg-card text-card-foreground",
  muted: "bg-muted",
  warning: "bg-warning-panel text-warning-ink",
} as const satisfies Record<PanelTone, string>;

type PanelHeading =
  | {
      /** The panel's name: 13px semibold, never a header band. */
      title: ReactNode;
      headingAs: "h1" | "h2" | "h3" | "h4";
    }
  | { title?: undefined; headingAs?: undefined };

export type PanelProps = Omit<useRender.ComponentProps<"div">, "title"> &
  PanelHeading & {
    tone: PanelTone;
    /** One quiet line under the title. */
    caption?: ReactNode;
    /** Quiet controls beside the title (Close, Clear). */
    actions?: ReactNode;
    /** A cover image above the title, running to the panel's edges. */
    media?: ReactNode;
    /** Media and tables run to the panel edge; the caller owns inner spacing. */
    flush?: boolean;
  };

/**
 * The only bordered box: focused flows (sign-in, consent, triage), repeated
 * list items and callouts. Resting page content stays flat in a `Section`.
 * `render` swaps the element (a link tile, a list item) without restyling it.
 */
export function Panel({
  tone,
  title,
  headingAs: Heading = "h3",
  caption,
  actions,
  media,
  flush = false,
  className,
  render,
  children,
  ...props
}: PanelProps) {
  const heading =
    title != null || caption != null ? (
      <div className="min-w-0">
        {title != null && (
          <Heading
            className={cn(
              "text-sm/4.5 font-semibold",
              tone === "warning" ? "text-warning" : "text-foreground",
            )}
          >
            {title}
          </Heading>
        )}
        {caption != null && (
          <p
            className={cn(
              "text-xs/4.5",
              tone === "warning" ? "text-warning-ink" : "text-muted-foreground",
            )}
          >
            {caption}
          </p>
        )}
      </div>
    ) : null;
  const header =
    heading != null || actions != null ? (
      <div
        className={cn(
          "flex min-w-0 items-start justify-between gap-2",
          flush && "px-3 pt-2.5",
          children != null ? "mb-2" : flush && "pb-2.5",
        )}
      >
        {heading}
        {actions != null && (
          <div className="-my-1 flex shrink-0 items-center gap-1.5">
            {actions}
          </div>
        )}
      </div>
    ) : null;
  const body = header ? (
    <>
      {header}
      {children}
    </>
  ) : (
    children
  );
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(
      {
        className: cn(
          "min-w-0 rounded-sm text-sm",
          TONE_CLASS[tone],
          flush || media != null ? "overflow-hidden" : "px-3 py-2.5",
          className,
        ),
        children:
          media != null ? (
            <>
              {media}
              <div className={cn(!flush && "px-3 py-2.5")}>{body}</div>
            </>
          ) : (
            body
          ),
      },
      props,
    ),
    state: { slot: "panel", tone },
  });
}
