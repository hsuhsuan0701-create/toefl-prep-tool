import { useState } from "react";
import type { FullTestRunVM } from "@toefl-prep/shared";
import { nextSectionToSit } from "../hooks/useFullTestRun";
import { abandonFullTest } from "../lib/api";
import { requestErrorMessage } from "../lib/requestError";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SECTION_LABEL } from "../ui/labels";

/**
 * What abandoning this Run does, concretely (POST /api/full-tests/:id/abandon): the Run ends with no
 * Overall, the sections already finished keep their Attempts and bands, and the section left
 * part-way, if there is one, is discarded.
 */
function abandonConsequence(run: FullTestRunVM): string[] {
  const finished = run.sections.filter((s) => s.state === "completed").length;
  const live = run.sections.find((s) => s.state === "in-progress");
  return [
    "The Run ends here, without an Overall band: the Overall needs all four sections.",
    finished === 0
      ? "No section has been finished yet, so nothing is kept from it."
      : `The ${finished === 1 ? "section you finished keeps its Attempt and its band" : `${finished} sections you finished keep their Attempts and their bands`}.`,
    ...(live ? [`The ${SECTION_LABEL[live.section]} section you left part-way is discarded.`] : []),
    "This can't be undone.",
  ];
}

/**
 * "Abandon Run…" for a Full-Test Run in progress, behind a confirmation that says what it does. Shared by
 * the Run's own page and the Dashboard's Full-Test panel. Starting a Run asks nothing, because this
 * is how a Run started by mistake goes away.
 *
 * Nothing renders for a Run with no section left to sit: its hand-off was lost, it is finished
 * rather than given up on, and the route refuses to abandon it. Its Run page completes it.
 */
export default function AbandonFullTestRun({
  run,
  onAbandoned,
  size = "md",
}: {
  run: FullTestRunVM;
  onAbandoned: (run: FullTestRunVM) => void;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const abandoned = await abandonFullTest(run.id);
      setOpen(false);
      onAbandoned(abandoned);
    } catch (e) {
      setError(requestErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!nextSectionToSit(run)) return null;

  return (
    <>
      <Button
        variant="quiet"
        size={size}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Abandon Run…
      </Button>
      <ConfirmDialog
        open={open}
        title="Abandon this Full-Test Run?"
        confirmLabel="Abandon Run"
        cancelLabel="Keep the Run"
        tone="destructive"
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={() => setOpen(false)}
      >
        {abandonConsequence(run).map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
        {error && <p className="font-medium text-critical">Couldn't abandon the Run. {error}</p>}
      </ConfirmDialog>
    </>
  );
}
