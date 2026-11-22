import type { ArrowKind } from '../../types/document';

interface ArrowGlyphProps {
  kind: ArrowKind;
  width?: number;
  height?: number;
}

export function ArrowGlyph({ kind, width = 64, height = 24 }: ArrowGlyphProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 64 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'reaction' && (
        <>
          <path d="M5 12h48" />
          <path d="M48 6.6l8 5.4-8 5.4" fill="currentColor" stroke="none" />
        </>
      )}
      {kind === 'equilibrium' && (
        <>
          <path d="M6 8.5h48" />
          <path d="M49 4.4l6 4.1-6 4.1" />
          <path d="M58 15.5H10" />
          <path d="M15 11.4l-6 4.1 6 4.1" />
        </>
      )}
      {kind === 'retro' && (
        <>
          <path d="M5 12h44" />
          <path d="M44 6.6l8 5.4-8 5.4" />
          <path d="M31 5.5l-6 13M38 5.5l-6 13" strokeWidth={1.8} />
        </>
      )}
      {kind === 'mechanism' && (
        <>
          <path d="M6 19C18 3.5 42 3.5 55 12" />
          <path d="M46.5 11.2l9 1.4-3.6 8" />
        </>
      )}
    </svg>
  );
}
