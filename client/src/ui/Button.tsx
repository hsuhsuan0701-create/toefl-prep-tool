import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./buttonStyles";
import { cx } from "./cx";
import { IconSpinner } from "./icons";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container's width (phone footers, dialog actions). */
  block?: boolean;
  /** Busy with a request this button started: ignores clicks, shows a spinner, keeps the label. */
  loading?: boolean;
  /** Leading icon from ui/icons.tsx. Replaced by the spinner while loading. */
  icon?: ReactNode;
  /** Trailing icon, for a step forward ("Next →"). */
  iconEnd?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
  children: ReactNode;
};

/**
 * The one button. While `loading` it stays focusable (aria-disabled, clicks ignored) rather than
 * becoming `disabled`, so keyboard focus is not thrown off the button the User just pressed.
 * Pick the variant by consequence, not looks:
 * - `primary` — the single most likely next step on the screen (one per view, at most one per card).
 * - `secondary` — any other real action.
 * - `quiet` — low-stakes or frequent actions inside rows and toolbars ("Edit", "Show detail").
 * - `destructive` — confirms an irreversible act, and appears only inside a ConfirmDialog; the
 *   row-level button that opens that dialog ("Discard…") is `quiet`.
 * Navigation that only goes somewhere is a ButtonLink or TextLink, never a Button with onClick.
 */
export function Button({
  variant = "secondary",
  size = "md",
  block,
  loading = false,
  icon,
  iconEnd,
  disabled,
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      className={cx(buttonClasses({ variant, size, block }), loading && "cursor-progress opacity-85", className)}
      {...rest}
      onClick={loading ? (e) => e.preventDefault() : rest.onClick}
    >
      {loading ? <IconSpinner size={size === "sm" ? 14 : 16} /> : icon}
      <span>{children}</span>
      {iconEnd}
    </button>
  );
}

type ButtonLinkProps = LinkProps & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  icon?: ReactNode;
  iconEnd?: ReactNode;
};

/** A router link that looks like a Button: "Start Simulation", "View report". Same variant rules. */
export function ButtonLink({ variant = "secondary", size = "md", block, icon, iconEnd, className, children, ...rest }: ButtonLinkProps) {
  return (
    <Link className={cx(buttonClasses({ variant, size, block }), "no-underline", className)} {...rest}>
      {icon}
      <span>{children}</span>
      {iconEnd}
    </Link>
  );
}

/**
 * An inline text link: inside a sentence, or a row's secondary destination ("See all 33 Sets").
 * Underlined so it never depends on colour alone.
 */
export function TextLink({ className, children, ...rest }: LinkProps) {
  return (
    <Link
      className={cx(
        "rounded-chip font-medium text-accent underline decoration-accent-rule decoration-1 underline-offset-[0.2em]",
        "transition-colors duration-(--duration-quick) hover:text-accent-strong hover:decoration-accent",
        className,
      )}
      {...rest}
    >
      {children}
    </Link>
  );
}
