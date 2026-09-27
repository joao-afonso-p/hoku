/** Hairline icon set, 16px grid, drawn to match the constellation's line weight. */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {children}
    </svg>
  );
}

export const IconGalaxy = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="3.2" cy="4.2" r="1" fill="currentColor" stroke="none" />
    <circle cx="12.6" cy="5" r="1" fill="currentColor" stroke="none" />
    <circle cx="11" cy="12.4" r="1" fill="currentColor" stroke="none" />
    <path d="M4 4.7 7 7.3M9.4 7.4l2.4-1.8M8.9 9.2l1.6 2.3" strokeOpacity={0.55} />
  </Svg>
);
export const IconPulse = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="5" strokeOpacity={0.5} />
  </Svg>
);
export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 5v3.2l2 1.3" />
  </Svg>
);
export const IconStar = (p: P) => (
  <Svg {...p}>
    <path d="m8 2.6 1.55 3.3 3.6.45-2.65 2.5.68 3.57L8 10.66l-3.18 1.76.68-3.57L2.85 6.35l3.6-.45Z" />
  </Svg>
);
export const IconStarFilled = (p: P) => (
  <Svg {...p}>
    <path d="m8 2.6 1.55 3.3 3.6.45-2.65 2.5.68 3.57L8 10.66l-3.18 1.76.68-3.57L2.85 6.35l3.6-.45Z" fill="currentColor" />
  </Svg>
);
export const IconProjects = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="5" r="2" />
    <circle cx="11" cy="5" r="2" />
    <circle cx="5" cy="11" r="2" />
    <circle cx="11" cy="11" r="2" />
  </Svg>
);
export const IconOrbit = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.2" />
    <ellipse cx="8" cy="8" rx="6.2" ry="3" transform="rotate(-24 8 8)" strokeOpacity={0.6} />
  </Svg>
);
export const IconSettings = (p: P) => (
  <Svg {...p}>
    <path d="M3 5h6M12 5h1M3 11h1M7 11h6" />
    <circle cx="10.5" cy="5" r="1.5" />
    <circle cx="5.5" cy="11" r="1.5" />
  </Svg>
);
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.2" />
    <path d="m10.2 10.2 3 3" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
);
export const IconScan = (p: P) => (
  <Svg {...p}>
    <path d="M2.8 5.5V3.8a1 1 0 0 1 1-1h1.7M10.5 2.8h1.7a1 1 0 0 1 1 1v1.7M13.2 10.5v1.7a1 1 0 0 1-1 1h-1.7M5.5 13.2H3.8a1 1 0 0 1-1-1v-1.7" />
    <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconArrowUpRight = (p: P) => (
  <Svg {...p}>
    <path d="M5 11 11 5M6 5h5v5" />
  </Svg>
);
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="7" height="7" rx="1.4" />
    <path d="M10.5 5.5V4.4a.9.9 0 0 0-.9-.9H4.4a.9.9 0 0 0-.9.9v5.2c0 .5.4.9.9.9h1.1" />
  </Svg>
);
export const IconLink = (p: P) => (
  <Svg {...p}>
    <path d="M7 9a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.6.6M9 7a2.6 2.6 0 0 0-3.7 0l-2 2A2.6 2.6 0 0 0 7 12.7l.6-.6" />
  </Svg>
);
export const IconFolder = (p: P) => (
  <Svg {...p}>
    <path d="M2.6 4.6a1 1 0 0 1 1-1h2.6l1.3 1.5h4.9a1 1 0 0 1 1 1v5.8a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1Z" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  </Svg>
);
export const IconChevronLeft = (p: P) => (
  <Svg {...p}>
    <path d="M9.8 3.8 5.6 8l4.2 4.2" />
  </Svg>
);
export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 4.8h9M6.5 4.8V3.6h3v1.2M4.6 4.8l.6 7.7h5.6l.6-7.7" />
  </Svg>
);
export const IconEdit = (p: P) => (
  <Svg {...p}>
    <path d="m10.3 3.4 2.3 2.3-6.8 6.8H3.5v-2.3Z" />
  </Svg>
);
/** Needs You: a tray with something waiting in it. */
export const IconInbox = (p: P) => (
  <Svg {...p}>
    <path d="M2.8 9.2 4.4 3.9a1 1 0 0 1 1-.7h5.2a1 1 0 0 1 1 .7l1.6 5.3v2.9a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1Z" />
    <path d="M2.8 9.2h3l.8 1.5h2.8l.8-1.5h3" />
  </Svg>
);
/** Activity: a timeline of beats. */
export const IconActivity = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 8h2.3l1.6-3.6 3 7.2 1.7-3.6h2.4" />
  </Svg>
);
/** Sessions: rows of a list. */
export const IconList = (p: P) => (
  <Svg {...p}>
    <path d="M5.6 4.5h7.4M5.6 8h7.4M5.6 11.5h7.4" />
    <circle cx="3.2" cy="4.5" r="0.7" fill="currentColor" stroke="none" />
    <circle cx="3.2" cy="8" r="0.7" fill="currentColor" stroke="none" />
    <circle cx="3.2" cy="11.5" r="0.7" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="m4.2 6.2 3.8 3.8 3.8-3.8" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m3.6 8.3 2.8 2.8 6-6.2" />
  </Svg>
);
/** Archive: a box with a lid. */
export const IconArchive = (p: P) => (
  <Svg {...p}>
    <rect x="2.6" y="3.2" width="10.8" height="3" rx="0.8" />
    <path d="M3.6 6.2v5.9a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1V6.2M6.6 8.7h2.8" />
  </Svg>
);
/** Follow up: a flag you plant to come back to. */
export const IconFlag = (p: P) => (
  <Svg {...p}>
    <path d="M4.2 13.4V2.8" />
    <path d="M4.2 3.3h7.6l-1.7 2.7 1.7 2.7H4.2" />
  </Svg>
);
export const IconFlagFilled = (p: P) => (
  <Svg {...p}>
    <path d="M4.2 13.4V2.8" />
    <path d="M4.2 3.3h7.6l-1.7 2.7 1.7 2.7H4.2" fill="currentColor" />
  </Svg>
);
