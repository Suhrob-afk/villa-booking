/**
 * A pencil, drawn inline for the same reasons as GearIcon: a character such
 * as ✎ is at the mercy of font fallback and emoji presentation, while this is
 * the same shape everywhere, sized by CSS and coloured by `currentColor`.
 */
export default function PencilIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
        <path d="M14.5 5.5l3 3" />
      </g>
    </svg>
  )
}
