import React from 'react';

/**
 * Vigil's logo lockup (mark and wordmark), used in the headers and the footer. The artwork lives in
 * public/brand: vigil-header.png for the lockup, favicon-*.png and apple-touch-icon.png for icons.
 * The image is 3x its display height so it stays sharp on high-density screens.
 */
export function VigilLogo({ className = '' }: { className?: string }) {
  return (
    <img
      className={`vigil-lockup ${className}`.trim()}
      src="/brand/vigil-header.png"
      alt="Vigil"
      width={303}
      height={96}
      decoding="async"
      draggable={false}
    />
  );
}
