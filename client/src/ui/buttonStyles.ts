import { cx } from "./cx";

// Button classes, shared by <Button>, <ButtonLink> and anything else that must look pressable
// (kept out of Button.tsx so that file exports only components — react/only-export-components).

export type ButtonVariant = "primary" | "secondary" | "quiet" | "destructive";
export type ButtonSize = "md" | "sm";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap select-none " +
  "transition-colors duration-(--duration-quick) ease-quiet " +
  "disabled:cursor-not-allowed";

// Heights: 40px (md) and 32px (sm) with a mouse; both grow to 44px on a touch screen.
const SIZE: Record<ButtonSize, string> = {
  md: "min-h-10 px-4 text-ui pointer-coarse:min-h-11",
  sm: "min-h-8 px-3 text-meta pointer-coarse:min-h-11 pointer-coarse:px-4",
};

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent border border-accent hover:bg-accent-strong hover:border-accent-strong " +
    "disabled:bg-well disabled:border-rule disabled:text-faint",
  secondary:
    "bg-sheet text-ink border border-rule-strong hover:bg-well hover:border-graphite " +
    "disabled:bg-sheet disabled:border-rule disabled:text-faint",
  quiet:
    "bg-transparent text-accent border border-transparent hover:bg-accent-wash " +
    "disabled:bg-transparent disabled:text-faint",
  destructive:
    "bg-critical text-on-critical border border-critical hover:brightness-95 " +
    "disabled:bg-well disabled:border-rule disabled:text-faint",
};

export function buttonClasses({
  variant = "secondary",
  size = "md",
  block = false,
}: { variant?: ButtonVariant; size?: ButtonSize; block?: boolean } = {}): string {
  return cx(BASE, SIZE[size], VARIANT[variant], block && "w-full");
}
