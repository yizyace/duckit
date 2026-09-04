import type { ComponentProps } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

// Native selection keeps the platform keyboard and screen-reader behavior.
export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <span className="relative block min-w-0">
      <select
        data-slot="select"
        className={cn(
          'h-10 w-full appearance-none rounded-lg border border-input bg-card py-2 pr-9 pl-3 text-sm shadow-xs disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  )
}
