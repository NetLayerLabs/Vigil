import React from 'react';

/** Vigil's watchtower glyph: base, shaft, lantern, beam. Shared by the landing page and the war room. */
export function VigilMark() {
  return (
    <svg viewBox="0 0 40 40" fill="currentColor" aria-hidden="true">
      <rect x="10" y="33" width="20" height="4" />
      <polygon points="15,33 25,33 23.5,15 16.5,15" />
      <rect x="14.5" y="8" width="11" height="6" fill="#17c784" />
      <polygon points="26,9.5 39,5 39,17 26,12.5" opacity="0.45" fill="#17c784" />
    </svg>
  );
}
