import type { SVGProps } from "react"

interface OhMyUsageLogoProps extends SVGProps<SVGSVGElement> {
  title?: string
}

export function OhMyUsageLogo({ title, ...props }: OhMyUsageLogoProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <path
        d="M6.5 5.5v10.25a9.5 9.5 0 0 0 19 0V5.5"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="square"
      />
      <path
        d="M12 5.5v9.75a4 4 0 0 0 8 0V5.5"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="square"
      />
    </svg>
  )
}
