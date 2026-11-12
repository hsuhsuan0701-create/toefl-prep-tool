import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { cx } from "./cx";

type InlineEditProps<T> = {
  /** Names what is edited, for the Edit button and the error: "Reading Target". */
  label: string;
  /** The saved value. While not editing this is what shows; a failed save returns the draft to it. */
  value: T;
  /** How the saved value reads when not editing. */
  display: ReactNode;
  /** The field, given the draft and its setter. The first input, select or textarea in it gets focus. */
  field: (draft: T, setDraft: (value: T) => void) => ReactNode;
  /** Persists the draft. Reject to keep the editor open with the error shown. */
  onSave: (value: T) => Promise<void>;
  className?: string;
};

/**
 * A saved value with a quiet "Edit" beside it that turns into a field plus Save and Cancel, in place:
 * a Target on a section card. Nothing is saved until Save; Escape or Cancel leaves the saved value as
 * it was. After saving or cancelling, focus returns to "Edit", so the keyboard does not lose its
 * place. A failed save keeps the editor open, puts the field back to the saved value, and says why.
 */
export function InlineEdit<T>({ label, value, display, field, onSave, className }: InlineEditProps<T>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  // Set when the editor closes, so focus goes back to "Edit" once it exists again.
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (editing) {
      editor.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  function close() {
    restoreFocus.current = true;
    setEditing(false);
    setError(null);
  }

  async function save() {
    if (saving) return;
    if (Object.is(draft, value)) {
      close();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      close();
    } catch (err) {
      setDraft(value);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className={cx("flex flex-wrap items-center justify-between gap-2", className)}>
        <div className="min-w-0">{display}</div>
        <Button
          ref={editButton}
          variant="quiet"
          size="sm"
          aria-label={`Edit ${label}`}
          onClick={() => {
            setDraft(value);
            setError(null);
            setEditing(true);
          }}
        >
          Edit
        </Button>
      </div>
    );
  }

  return (
    <div
      ref={editor}
      role="group"
      aria-label={`Edit ${label}`}
      className={cx("space-y-2", className)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !saving) {
          e.preventDefault();
          close();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        {field(draft, setDraft)}
        <Button size="sm" loading={saving} onClick={() => void save()}>
          Save
        </Button>
        <Button variant="quiet" size="sm" disabled={saving} onClick={close}>
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-meta text-critical">
          Couldn't save the {label}: {error}
        </p>
      )}
    </div>
  );
}
