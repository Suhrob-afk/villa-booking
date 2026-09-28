/**
 * A deliberately solid gear, drawn inline.
 *
 * It replaces the ⚙ character (U+2699) that used to sit in the villa settings
 * button. A character is at the mercy of font fallback, and U+2699 has both a
 * text and a colour-emoji presentation, so it rendered at a different weight
 * and size depending on the platform and ignored the button's font-size on
 * some of them. Geometry we control does not have that problem: this is the
 * same shape at every density, sized purely by CSS.
 *
 * `currentColor` also means it follows the button's colour into dark mode,
 * which a black PNG would not.
 */

/** Eight teeth, evenly spaced; one rect rotated about the centre each time. */
const TEETH = [0, 45, 90, 135, 180, 225, 270, 315]

export default function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {/* Punches the axle hole out of the solid body. */}
      <mask id="villa-gear-hole">
        <rect x="0" y="0" width="24" height="24" fill="#fff" />
        <circle cx="12" cy="12" r="3.3" fill="#000" />
      </mask>
      <g mask="url(#villa-gear-hole)" fill="currentColor">
        <circle cx="12" cy="12" r="7.3" />
        {TEETH.map((angle) => (
          <rect
            key={angle}
            x="10.3"
            y="1.5"
            width="3.4"
            height="5.5"
            rx="1.2"
            transform={`rotate(${angle} 12 12)`}
          />
        ))}
      </g>
    </svg>
  )
}
