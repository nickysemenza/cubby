"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "cn"
import { anchorOf } from "~/ui/overlays/anchor-proxy"
import { popoverElevationClassName } from "~/ui/overlays/popover-elevation"

/**
 * The trigger inside this root, so content can anchor to its stand-in
 * (`anchorOf`). A detached trigger (`handle`) lives outside the root and keeps
 * Base UI's own anchoring.
 */
const PopoverTriggerContext = React.createContext<{
  trigger: HTMLElement | null
  setTrigger: (node: HTMLElement | null) => void
} | null>(null)

function Popover<Payload = unknown>({
  ...props
}: PopoverPrimitive.Root.Props<Payload>) {
  const [trigger, setTrigger] = React.useState<HTMLElement | null>(null)
  const value = React.useMemo(
    () => (props.handle ? null : { trigger, setTrigger }),
    [props.handle, trigger]
  )
  return (
    <PopoverTriggerContext.Provider value={value}>
      <PopoverPrimitive.Root data-slot="popover" {...props} />
    </PopoverTriggerContext.Provider>
  )
}

function PopoverTrigger<Payload = unknown>({
  ref,
  ...props
}: PopoverPrimitive.Trigger.Props<Payload>) {
  const setTrigger = React.useContext(PopoverTriggerContext)?.setTrigger
  const setRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      setTrigger?.(node)
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref, setTrigger]
  )
  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      ref={setRef}
      {...props}
    />
  )
}

function PopoverContent({
  className,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  keepMounted = false,
  anchor,
  ...props
}: PopoverPrimitive.Popup.Props & { keepMounted?: boolean } &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "anchor"
  >) {
  const trigger = React.useContext(PopoverTriggerContext)?.trigger
  const proxied = React.useCallback(
    () => (trigger ? anchorOf(trigger) : null),
    [trigger]
  )
  return (
    <PopoverPrimitive.Portal keepMounted={keepMounted}>
      <PopoverPrimitive.Positioner
        anchor={anchor ?? (trigger ? proxied : undefined)}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            popoverElevationClassName,
            "bg-popover text-popover-foreground origin-(--transform-origin) duration-(--brand-motion-standard) ease-cozy data-closed:duration-(--brand-motion-exit) data-open:zoom-in-[0.98] data-closed:zoom-out-[0.98] data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 border-[var(--border)] flex flex-col gap-2 rounded-lg border p-3 text-sm z-50 w-72 origin-(--transform-origin) outline-hidden",
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn("text-sm font-medium", className)}
      {...props}
    />
  )
}

const createPopoverHandle = PopoverPrimitive.createHandle
type PopoverHandle<Payload> = ReturnType<
  typeof PopoverPrimitive.createHandle<Payload>
>

function PopoverDescription({
  className,
  ...props
}: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  createPopoverHandle,

  PopoverDescription,
}
export type { PopoverHandle }
