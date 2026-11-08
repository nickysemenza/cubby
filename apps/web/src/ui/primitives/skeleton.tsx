import { cn } from "cn"
import { SkeletonBox } from "skullet/react"

/** Static Skullet boxes do not measure hidden components or persist shapes. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("relative overflow-hidden rounded-md", className)}
      {...props}
    >
      <SkeletonBox className="absolute inset-0" width="100%" height="100%" radius="inherit" />
    </div>
  )
}

export { Skeleton }
