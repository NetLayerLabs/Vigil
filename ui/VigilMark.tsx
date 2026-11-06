import React from 'react';

/**
 * Vigil's mark: a solid tile with a V cut through it, standing on the release gate (the green bar).
 * The tile takes the text colour, so it is dark on light pages and light on dark ones; the V shows
 * whatever is behind it.
 */
export function VigilMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className="vigil-mark">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M7 0H25a7 7 0 0 1 7 7V25a7 7 0 0 1-7 7H7a7 7 0 0 1-7-7V7a7 7 0 0 1 7-7ZM7.5 6.5H13.1L16 15L18.9 6.5H24.5L18.9 20.5H13.1Z"
      />
      <rect x="7.5" y="23" width="17" height="3" rx="0.75" fill="var(--brand, #17c784)" />
    </svg>
  );
}
