import * as React from "react"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

const SIZE = {
  sm: "size-4",
  md: "size-5",
  lg: "size-6",
} as const

/**
 * A spinning loader. Centralizes the `Loader2 animate-spin` pattern used ad hoc
 * across atoms (status, interactive) so the loading vocabulary reads as one
 * control. `aria-hidden` by default — pair it with a visible/`sr-only` label.
 */
function Spinner({
  className,
  size = "md",
  ...props
}: React.ComponentProps<typeof Loader2> & { size?: keyof typeof SIZE }) {
  return (
    <Loader2
      aria-hidden="true"
      className={cn("animate-spin text-muted-foreground", SIZE[size], className)}
      {...props}
    />
  )
}

export { Spinner }
