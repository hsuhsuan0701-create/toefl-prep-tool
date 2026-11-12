import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./Button";
import { cx } from "./cx";

type DialogPanelProps = {
  title: ReactNode;
  children?: ReactNode;
  /** The buttons, cancel first (left) and the consequential one last (right). */
  actions: ReactNode;
  titleId?: string;
  bodyId?: string;
  className?: string;
};

/**
 * The visual body of a dialog, without the modal behaviour. ConfirmDialog renders it inside a native
 * <dialog>; the design preview renders it in place. Pages should not use it directly.
 */
export function DialogPanel({ title, children, actions, titleId, bodyId, className }: DialogPanelProps) {
  return (
    <div className={cx("w-full max-w-md rounded-sheet border border-rule bg-sheet p-5 shadow-overlay sm:p-6", className)}>
      <h2 id={titleId} className="text-heading font-semibold text-ink">
        {title}
      </h2>
      {children && (
        <div id={bodyId} className="mt-2 space-y-2 text-ui text-ink-soft text-pretty">
          {children}
        </div>
      )}
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{actions}</div>
    </div>
  );
}

type ConfirmDialogProps = {
  open: boolean;
  /** A question naming the act: "Discard this Attempt?" */
  title: ReactNode;
  /** What happens, concretely, including what cannot be undone. */
  children?: ReactNode;
  /** The act itself, as a verb: "Discard", "Finish and score". Never "OK" or "Yes". */
  confirmLabel: string;
  cancelLabel?: string;
  /** `destructive` for acts that lose work; focus then starts on Cancel, not on the act. */
  tone?: "default" | "destructive";
  /** True while the confirmed request is in flight; keeps the dialog open with a spinner. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Asks before an act that is hard to undo or changes what gets scored (Discard; "Finish and score",
 * where unrecorded Items score 0; leaving a running Drill or Simulation). Built on the native
 * <dialog>, so focus is trapped and Escape cancels without any focus-management code here. Where
 * showModal is missing (jsdom in tests) it falls back to a plain open dialog.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "default",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      // After showModal, which would otherwise pick its own first focus target.
      (tone === "destructive" ? cancelRef : confirmRef).current?.focus();
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open, tone]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={children ? bodyId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md bg-transparent p-0 text-ink backdrop:bg-ink/30"
    >
      {open && (
        <DialogPanel
          title={title}
          titleId={titleId}
          bodyId={bodyId}
          actions={
            <>
              <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy}>
                {cancelLabel}
              </Button>
              <Button ref={confirmRef} variant={tone === "destructive" ? "destructive" : "primary"} onClick={onConfirm} loading={busy}>
                {confirmLabel}
              </Button>
            </>
          }
        >
          {children}
        </DialogPanel>
      )}
    </dialog>
  );
}
