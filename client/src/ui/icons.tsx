import type { ReactNode, SVGProps } from "react";
import type { Glyph } from "./labels";

// The app's icons, drawn inline on one 16×16 grid with a 1.5 stroke. No icon package: the app works
// offline and needs only the twenty or so shapes below.
//
// Icons are decorative by default (aria-hidden). An icon that carries meaning on its own — rare;
// prefer words beside it — passes `title`, which makes it an img with that accessible name.

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { title?: string; size?: number };

function Icon({ title, size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-label={title}
      focusable="false"
      className="shrink-0"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Icon>
);

export const IconCross = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </Icon>
);

export const IconInfo = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25V11M8 5v.01" />
  </Icon>
);

export const IconCaution = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.25L14.25 13.25H1.75z" />
    <path d="M8 6.5v3M8 11.25v.01" />
  </Icon>
);

export const IconCritical = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.4 1.75h5.2l3.65 3.65v5.2l-3.65 3.65H5.4L1.75 10.6V5.4z" />
    <path d="M8 4.75v3.75M8 10.75v.01" />
  </Icon>
);

export const IconArrowRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.75 8h10.5M9.25 4l4 4-4 4" />
  </Icon>
);

export const IconArrowLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.25 8H2.75M6.75 4l-4 4 4 4" />
  </Icon>
);

export const IconChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6l4 4 4-4" />
  </Icon>
);

export const IconChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 4l4 4-4 4" />
  </Icon>
);

export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 4.5V8l2.5 1.5" />
  </Icon>
);

export const IconFlag = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 14V2.5M3.5 2.75h8l-1.75 3 1.75 3h-8" />
  </Icon>
);

export const IconRepeat = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.75 7V6a2 2 0 012-2h8.5M11 1.75L13.25 4 11 6.25M13.25 9v1a2 2 0 01-2 2h-8.5M5 14.25L2.75 12 5 9.75" />
  </Icon>
);

/** A microphone: the mic check, and anything that records. */
export const IconMic = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
    <path d="M3.25 7.5a4.75 4.75 0 009.5 0M8 12.25v2" />
  </Icon>
);

/** A filled square: stop recording. */
export const IconStop = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />
  </Icon>
);

/** A filled triangle: play once. */
export const IconPlay = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 3.25v9.5L12.75 8z" fill="currentColor" />
  </Icon>
);

/** Six dots: something you pick up and drag (a Build a Sentence tile). */
export const IconGrip = (p: IconProps) => (
  <Icon {...p}>
    <g fill="currentColor" stroke="none">
      <circle cx="6" cy="4" r="1.1" />
      <circle cx="10" cy="4" r="1.1" />
      <circle cx="6" cy="8" r="1.1" />
      <circle cx="10" cy="8" r="1.1" />
      <circle cx="6" cy="12" r="1.1" />
      <circle cx="10" cy="12" r="1.1" />
    </g>
  </Icon>
);

/** The "something is happening" ring. Spins unless the User asked for reduced motion. */
export const IconSpinner = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" opacity="0.25" />
    <path d="M14 8a6 6 0 00-6-6" className="origin-center animate-spin" />
  </Icon>
);

/** A half-filled ring: started, not finished. */
export const IconProgress = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 2.5a5.5 5.5 0 010 11z" fill="currentColor" stroke="none" />
  </Icon>
);

/** An empty dashed ring: not started. */
export const IconPending = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5.5" strokeDasharray="2.2 2.2" />
  </Icon>
);

export const IconDash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 8h8" />
  </Icon>
);

/** The shape for a status glyph name (ui/labels.ts). `none` renders nothing. */
export function StatusGlyph({ glyph, size = 14 }: { glyph: Glyph; size?: number }) {
  switch (glyph) {
    case "check":
      return <IconCheck size={size} />;
    case "cross":
      return <IconCross size={size} />;
    case "progress":
      return <IconProgress size={size} />;
    case "pending":
      return <IconPending size={size} />;
    case "caution":
      return <IconCaution size={size} />;
    case "dash":
      return <IconDash size={size} />;
    case "none":
      return null;
  }
}
