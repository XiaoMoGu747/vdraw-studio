import type { ReactNode } from 'react';
import type { IconName } from '../../types/ui';

interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

function renderIcon(name: IconName): ReactNode {
  switch (name) {
    case 'logo':
      return (
        <>
          <path d="M6.2 7.2l5 9.4 3.4-6.8" />
          <circle cx="17.6" cy="6.9" r="1.9" />
          <path d="M17.6 8.8v3.1" opacity="0.55" />
        </>
      );
    case 'select':
      return (
        <>
          <path d="M5.4 3.4l13.6 8.3-5.7 1.4-2.6 5.5z" />
          <path d="M12.7 13.1l4.3 4.3" />
        </>
      );
    case 'node':
      return (
        <>
          <path d="M4.5 17.5c3.5-10 11-10.5 15.5-4.5" />
          <rect x="2.5" y="15.5" width="3.4" height="3.4" rx="0.4" />
          <rect x="17.6" y="11.4" width="3.4" height="3.4" rx="0.4" />
          <path d="M5.9 15.7l3.2-3.2M14.4 13l3.2-1.6" opacity="0.5" />
          <circle cx="8.9" cy="12.7" r="1.1" />
          <circle cx="14.4" cy="13" r="1.1" />
        </>
      );
    case 'pen':
      return (
        <>
          <path d="M4 20l4.7-1.4L20 7.3l-3.3-3.3L5.4 15.3z" />
          <path d="M14.7 6l3.3 3.3" />
          <path d="M5.4 15.3l3.3 3.3" opacity="0.55" />
        </>
      );
    case 'curve':
      return (
        <>
          <path d="M4 18c0-8 5.5-12 16-12" />
          <circle cx="4" cy="18" r="1.7" />
          <circle cx="20" cy="6" r="1.7" />
          <path d="M4 18l5-1M20 6l-5 1" opacity="0.5" />
        </>
      );
    case 'rect':
      return <rect x="4" y="6" width="16" height="12" rx="1.6" />;
    case 'corner':
      return (
        <>
          <path d="M5 19V11a6 6 0 0 1 6-6h8" />
          <path d="M5 19h3M19 5v3" opacity="0.45" />
        </>
      );
    case 'settings':
      return (
        <>
          <circle cx="12" cy="12" r="3.1" />
          <path d="M12 3.2v2.2M12 18.6v2.2M3.2 12h2.2M18.6 12h2.2M5.8 5.8l1.6 1.6M16.6 16.6l1.6 1.6M18.2 5.8l-1.6 1.6M7.4 16.6l-1.6 1.6" />
        </>
      );
    case 'square':
      return <rect x="5.5" y="5.5" width="13" height="13" rx="1.2" />;
    case 'ellipse':
      return <ellipse cx="12" cy="12" rx="8.6" ry="6.6" />;
    case 'circle':
      return <circle cx="12" cy="12" r="7.2" />;
    case 'polygon':
      return <path d="M12 3.4l8.2 6-3.1 9.8H6.9L3.8 9.4z" />;
    case 'line':
      return (
        <>
          <path d="M5.6 18.4L18.4 5.6" />
          <circle cx="5.6" cy="18.4" r="1.5" />
          <circle cx="18.4" cy="5.6" r="1.5" />
        </>
      );
    case 'text':
      return (
        <>
          <path d="M5.5 6.6V5h13v1.6" />
          <path d="M12 5v14M8.6 19h6.8" />
        </>
      );
    case 'bond':
      return (
        <>
          <path d="M6 19.2L17.4 6.4" />
          <path d="M9.4 21L20.4 8.6" opacity="0.85" />
        </>
      );
    case 'atom':
      return (
        <>
          <circle cx="12" cy="12" r="2.2" />
          <ellipse cx="12" cy="12" rx="9" ry="4.3" transform="rotate(-38 12 12)" />
          <ellipse cx="12" cy="12" rx="9" ry="4.3" transform="rotate(38 12 12)" opacity="0.7" />
        </>
      );
    case 'ring':
      return (
        <>
          <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />
          <circle cx="12" cy="12" r="4.5" />
        </>
      );
    case 'chemistry':
      // 独立“化学工具”图标：烧瓶 + 气泡，区别于化学键
      return (
        <>
          <path d="M9 3h6" />
          <path d="M10 3v5.4l-4.4 7.5A2 2 0 0 0 7.3 19h9.4a2 2 0 0 0 1.7-3.1L14 8.4V3" />
          <path d="M7.6 14.6h8.8" />
          <circle cx="10.4" cy="12" r="0.85" fill="currentColor" stroke="none" />
          <circle cx="14.1" cy="9.9" r="0.65" fill="currentColor" stroke="none" />
        </>
      );
    case 'arrow':
      return (
        <>
          <path d="M4 12h13.4" />
          <path d="M13 7.4L18 12l-5 4.6" />
        </>
      );
    case 'hand':
      return (
        <>
          <path d="M8.2 12.6V6.4a1.7 1.7 0 013.4 0V11" />
          <path d="M11.6 10.8V5.2a1.7 1.7 0 013.4 0v5.4" />
          <path d="M15 10.6V7.4a1.7 1.7 0 013.4 0v6.4c0 4.6-2.8 7.4-6.9 7.4-2.6 0-4.2-1.1-5.4-3l-2.4-3.9c-.7-1.1.7-2.4 1.8-1.5l1.7 1.5" />
        </>
      );
    case 'zoom':
      return (
        <>
          <circle cx="10.6" cy="10.6" r="6.4" />
          <path d="M15.4 15.4L21 21" />
        </>
      );
    case 'zoomIn':
      return (
        <>
          <circle cx="10.6" cy="10.6" r="6.4" />
          <path d="M15.4 15.4L21 21M10.6 7.8v5.6M7.8 10.6h5.6" />
        </>
      );
    case 'zoomOut':
      return (
        <>
          <circle cx="10.6" cy="10.6" r="6.4" />
          <path d="M15.4 15.4L21 21M7.8 10.6h5.6" />
        </>
      );
    case 'eyedropper':
      return (
        <>
          <path d="M14.6 6.2l3.2 3.2" />
          <path d="M16.2 2.8l5 5-2 2-5-5z" />
          <path d="M14.8 7.4L5 17.2V21h3.8l9.8-9.8z" />
        </>
      );
    case 'undo':
      return (
        <>
          <path d="M8.4 7L4 11.2l4.4 4.2" />
          <path d="M4 11.2h9.2a5.6 5.6 0 010 11.2h-2" />
        </>
      );
    case 'redo':
      return (
        <>
          <path d="M15.6 7L20 11.2l-4.4 4.2" />
          <path d="M20 11.2h-9.2a5.6 5.6 0 000 11.2h2" />
        </>
      );
    case 'grid':
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="1.4" />
          <path d="M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16" opacity="0.75" />
        </>
      );
    case 'grid4':
      return (
        <>
          <rect x="4" y="4" width="6.5" height="6.5" rx="1" />
          <rect x="13.5" y="4" width="6.5" height="6.5" rx="1" />
          <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" />
          <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" />
        </>
      );
    case 'crop':
      return (
        <>
          <path d="M6.6 3v14.4H21" />
          <path d="M3 6.6h14.4V21" />
        </>
      );
    case 'image':
      return (
        <>
          <rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2" />
          <circle cx="8.8" cy="9.6" r="1.5" />
          <path d="M4.2 17.6l4.9-4.6 3.4 3.1 3.1-2.7 4.3 3.8" />
        </>
      );
    case 'snap':
      return (
        <>
          <path d="M6 4v8.2a6 6 0 0012 0V4h-3.6v8.2a2.4 2.4 0 01-4.8 0V4z" />
          <path d="M6 7.6h4.4M13.6 7.6H18" opacity="0.7" />
        </>
      );
    case 'ruler':
      return (
        <>
          <rect x="2.6" y="8" width="18.8" height="8" rx="1.4" />
          <path d="M6.6 8v3.2M10 8v4.4M13.4 8v3.2M16.8 8v4.4" />
        </>
      );
    case 'eye':
      return (
        <>
          <path d="M2.6 12S6.2 5.6 12 5.6 21.4 12 21.4 12 17.8 18.4 12 18.4 2.6 12 2.6 12z" />
          <circle cx="12" cy="12" r="3" />
        </>
      );
    case 'eyeOff':
      return (
        <>
          <path d="M4 5.4l16 15.2" />
          <path d="M9.4 6.2A9.8 9.8 0 0112 5.6c5.8 0 9.4 6.4 9.4 6.4a17 17 0 01-3.3 4.1M6.4 8A16.4 16.4 0 002.6 12S6.2 18.4 12 18.4c1.3 0 2.5-.3 3.6-.8" />
          <path d="M10 10.2a2.8 2.8 0 003.9 4" />
        </>
      );
    case 'lock':
      return (
        <>
          <rect x="5" y="10" width="14" height="10" rx="2" />
          <path d="M8.4 10V7.6a3.6 3.6 0 017.2 0V10" />
          <path d="M12 14v2.4" opacity="0.7" />
        </>
      );
    case 'unlock':
      return (
        <>
          <rect x="5" y="10" width="14" height="10" rx="2" />
          <path d="M8.4 10V7.6a3.6 3.6 0 017-1.2" />
          <path d="M12 14v2.4" opacity="0.7" />
        </>
      );
    case 'plus':
      return <path d="M12 5.2v13.6M5.2 12h13.6" />;
    case 'minus':
      return <path d="M5.2 12h13.6" />;
    case 'trash':
      return (
        <>
          <path d="M4.4 7h15.2M9.6 7V4.6h4.8V7" />
          <path d="M6.6 7l1 13h8.8l1-13M10.2 11v5M13.8 11v5" />
        </>
      );
    case 'chevronDown':
      return <path d="M6.4 9.4l5.6 5.6 5.6-5.6" />;
    case 'chevronRight':
      return <path d="M9.4 6.4l5.6 5.6-5.6 5.6" />;
    case 'layers':
      return (
        <>
          <path d="M12 3.2l8.8 4.9L12 13 3.2 8.1z" />
          <path d="M3.2 12.2L12 17.1l8.8-4.9M3.2 16.2L12 21.1l8.8-4.9" opacity="0.75" />
        </>
      );
    case 'alignLeft':
      return (
        <>
          <path d="M4 4v16" />
          <rect x="7" y="6" width="12" height="4" rx="0.8" />
          <rect x="7" y="14" width="8" height="4" rx="0.8" />
        </>
      );
    case 'alignCenterH':
      return (
        <>
          <path d="M12 3.6v16.8" />
          <rect x="4" y="6" width="16" height="4" rx="0.8" />
          <rect x="7" y="14" width="10" height="4" rx="0.8" />
        </>
      );
    case 'alignRight':
      return (
        <>
          <path d="M20 4v16" />
          <rect x="5" y="6" width="12" height="4" rx="0.8" />
          <rect x="9" y="14" width="8" height="4" rx="0.8" />
        </>
      );
    case 'alignTop':
      return (
        <>
          <path d="M4 4h16" />
          <rect x="6" y="7" width="4" height="12" rx="0.8" />
          <rect x="14" y="7" width="4" height="8" rx="0.8" />
        </>
      );
    case 'alignCenterV':
      return (
        <>
          <path d="M3.6 12h16.8" />
          <rect x="6" y="4" width="4" height="16" rx="0.8" />
          <rect x="14" y="7" width="4" height="10" rx="0.8" />
        </>
      );
    case 'alignBottom':
      return (
        <>
          <path d="M4 20h16" />
          <rect x="6" y="5" width="4" height="12" rx="0.8" />
          <rect x="14" y="9" width="4" height="8" rx="0.8" />
        </>
      );
    case 'distributeH':
      return (
        <>
          <path d="M4 5v14M20 5v14" />
          <rect x="9" y="7" width="6" height="10" rx="0.8" />
        </>
      );
    case 'distributeV':
      return (
        <>
          <path d="M5 4h14M5 20h14" />
          <rect x="7" y="9" width="10" height="6" rx="0.8" />
        </>
      );
    case 'download':
      return (
        <>
          <path d="M12 3.8v11.4M7.6 11l4.4 4.4 4.4-4.4" />
          <path d="M4.4 19.2h15.2" />
        </>
      );
    case 'folder':
      return (
        <path d="M3.4 7.6a2 2 0 012-2h4l2 2.6h7.2a2 2 0 012 2v7.2a2 2 0 01-2 2H5.4a2 2 0 01-2-2z" />
      );
    case 'file':
      return (
        <>
          <path d="M6 3.2h8.2L18.4 7.4v13.4H6z" />
          <path d="M14.2 3.2v4.4h4.2" />
        </>
      );
    case 'save':
      return (
        <>
          <path d="M4.6 4.4h11.6l3.2 3.2v12H4.6z" />
          <path d="M8.2 4.4v5h7v-5M8.2 19.6v-5.8h7.6v5.8" />
        </>
      );
    case 'close':
      return <path d="M6.2 6.2l11.6 11.6M17.8 6.2L6.2 17.8" />;
    case 'minimize':
      return <path d="M5 12h14" />;
    case 'maximize':
      return <rect x="5" y="5" width="14" height="14" />;
    case 'restore':
      return (
        <>
          <rect x="4" y="8" width="11" height="11" rx="0.8" />
          <path d="M8 8V5h11v11h-3" />
        </>
      );
    case 'check':
      return <path d="M5 12.6l4.6 4.6L19 7.2" />;
    case 'warning':
      return (
        <>
          <path d="M12 3.6l8.8 15.6H3.2z" />
          <path d="M12 9v4.6M12 16.6v.4" />
        </>
      );
    case 'info':
      return (
        <>
          <circle cx="12" cy="12" r="8.6" />
          <path d="M12 11v5.4M12 7.8v.4" />
        </>
      );
    case 'fit':
      return (
        <>
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </>
      );
    case 'molecule':
      return (
        <>
          <circle cx="5" cy="17.4" r="2" />
          <circle cx="12" cy="6.6" r="2" />
          <circle cx="19" cy="15.4" r="2" />
          <path d="M6.5 15.7l4-7.5M13.8 7.9l3.8 5.8" />
        </>
      );
    case 'palette':
      return (
        <>
          <path d="M12 3.2a8.8 8.8 0 000 17.6c1.8 0 2-1.5 1-2.4-1.2-1.1 0-2.8 1.6-2.8H17a4 4 0 004-4c0-4.8-4-8.4-9-8.4z" />
          <circle cx="8" cy="10" r="1" />
          <circle cx="12" cy="7.4" r="1" />
          <circle cx="16" cy="9.6" r="1" />
        </>
      );
    case 'properties':
      return (
        <>
          <path d="M4 7h9M18 7h2M4 12h4M13 12h7M4 17h11M20 17h0" />
          <circle cx="15.5" cy="7" r="2.1" />
          <circle cx="10.5" cy="12" r="2.1" />
          <circle cx="17.5" cy="17" r="2.1" />
        </>
      );
    case 'history':
      return (
        <>
          <path d="M4.4 10.4A8 8 0 1112 20" />
          <path d="M4.4 4.8v5.6H10" />
          <path d="M12 7.8V12l3 2" />
        </>
      );
    case 'brush':
      return (
        <>
          <path d="M15.2 4.6l4.2 4.2-7.6 7.6-4.2-4.2z" />
          <path d="M7.6 12.2c-1.9.4-2.9 1.6-3.2 3.4-.2 1.4-.8 2.4-2 3.2 2.6.7 4.8.2 6.2-1.2 1-1 1.4-2.1 1.2-3.2" />
        </>
      );
    case 'bucket':
      return (
        <>
          <path d="M5.4 11.2l6.2-6.4 6.2 6.4-6.2 6.2z" />
          <path d="M4.2 12.4h13.6" />
          <path d="M18.6 14.4c.9 1.3 1.4 2.2 1.4 2.9a1.5 1.5 0 11-3 0c0-.7.5-1.6 1.6-2.9z" />
        </>
      );
    case 'symmetry':
      return (
        <>
          <path d="M12 3.4v17.2" strokeDasharray="3 2.4" />
          <path d="M8.6 7.2L4 17.4h4.6zM15.4 7.2L20 17.4h-4.6z" />
        </>
      );
    case 'perspective':
      return (
        <>
          <path d="M3.4 18.6h17.2" />
          <path d="M4.6 18.6L12 6.6l7.4 12" />
          <path d="M7.4 18.6l4.6-7.4 4.6 7.4" />
        </>
      );
    case 'eraser':
      return (
        <>
          <path d="M8.2 19.4h10" />
          <path d="M5.1 15.2l7.3-7.3a1.9 1.9 0 012.7 0l3.3 3.3a1.9 1.9 0 010 2.7l-4.3 4.3H8.5z" />
          <path d="M9.6 10.7l5.6 5.6" />
        </>
      );
    case 'copy':
      return (
        <>
          <rect x="8.4" y="8.4" width="11.2" height="11.2" rx="1.6" />
          <path d="M15.6 8.4V5.8a1.4 1.4 0 00-1.4-1.4H5.8a1.4 1.4 0 00-1.4 1.4v8.4a1.4 1.4 0 001.4 1.4h2.6" />
        </>
      );
    case 'merge':
      return (
        <>
          <path d="M12 3.6v9.2" />
          <path d="M8.4 9.4L12 13l3.6-3.6" />
          <path d="M4 16.4h16M4 20h16" opacity="0.65" />
        </>
      );
    default:
      return null;
  }
}

export function Icon({ name, size = 18, strokeWidth = 1.6, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {renderIcon(name)}
    </svg>
  );
}
