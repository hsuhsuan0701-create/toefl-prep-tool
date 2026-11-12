import { useEffect, useId, useRef, type ReactNode } from "react";
import { DialogPanel } from "./ConfirmDialog";

type DialogProps = {
  open: boolean;
  /** What the dialog is for, as a short title: "Generate Sets". */
  title: ReactNode;
  children: ReactNode;
  /** The buttons, the dismissing one first and the one that acts last. */
  actions: ReactNode;
  /** Called on Escape, except while `busy`; the dismissing button in `actions` calls it too. */
  onClose: () => void;
  /** True while the dialog's own request is in flight: Escape does nothing until it settles. */
  busy?: boolean;
};

/**
 * A modal for a small form that is not an answer to a question: choosing which Sets to generate.
 * Built on the native <dialog>, like ConfirmDialog, so focus is trapped and Escape closes it without
 * focus-management code here; it looks the same (DialogPanel). For a yes/no about a consequence, use
 * ConfirmDialog. Where showModal is missing (jsdom) it falls back to a plain open dialog.
 */
export function Dialog({ open, title, children, actions, onClose, busy = false }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto bg-transparent p-0 text-ink backdrop:bg-ink/30"
    >
      {open && (
        <DialogPanel title={title} titleId={titleId} actions={actions}>
          {children}
        </DialogPanel>
      )}
    </dialog>
  );
}
