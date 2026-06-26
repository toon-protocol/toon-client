import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A pulsing placeholder block. Rides the `--muted` token, so it adapts to
 * light/dark with no extra work. Used by the `skeleton` atom to mimic a real
 * layout while the agent computes the actual view.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
