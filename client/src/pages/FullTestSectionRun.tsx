import { useNavigate, useParams } from "react-router-dom";
import { NOT_RUNNABLE, isTerminalSection, useFullTestRun } from "../hooks/useFullTestRun";
import { Button, TextLink } from "../ui/Button";
import { PageHeader } from "../ui/Heading";
import { IconArrowLeft } from "../ui/icons";
import { Notice } from "../ui/Notice";
import { PageShell } from "../ui/PageShell";
import { Skeleton } from "../ui/Skeleton";
import { SECTION_LABEL } from "../ui/labels";
import { ListeningSimulation, ReadingSimulation, SpeakingSimulation, WritingSimulation } from "./simulation/sectionSimulations";

/**
 * `/full-test/:runId/:section` — the gate that hands a section to its own Simulation. The Simulation
 * does not choose its Set: the Run drew it at creation, so it is read here from the Run (which
 * survives a reload, unlike router state) and passed down.
 */
export default function FullTestSectionRun() {
  const { runId, section } = useParams<{ runId: string; section: string }>();
  const navigate = useNavigate();
  const { run, error, loading } = useFullTestRun(runId);

  if (loading) {
    return (
      <PageShell nav={false} width="measure">
        <div aria-busy="true" aria-label="Loading the Full-Test Run" className="space-y-4">
          <Skeleton className="h-9 w-56" shape="block" />
          <Skeleton lines={3} />
        </div>
      </PageShell>
    );
  }

  const sectionVM = run?.sections.find((s) => s.section === section);

  if (error || !run || !sectionVM) {
    return (
      <PageShell nav={false} width="measure">
        <PageHeader
          kicker={
            <TextLink to={runId ? `/full-test/${runId}` : "/"} className="inline-flex items-center gap-1">
              <IconArrowLeft size={14} />
              Full-Test Run
            </TextLink>
          }
          title="Section not found"
        />
        <Notice tone="critical">{error ?? `This Full-Test Run has no "${section}" section.`}</Notice>
      </PageShell>
    );
  }

  // Refused rather than rendered, on the server's own `launchable`: re-sitting a completed section
  // would create a second Attempt the Run cannot record, and sitting one out of ETS order would jump
  // the exam. The server refuses to link an Attempt for both, so rendering the Simulation would only
  // walk the User into that refusal after the intro screen.
  if (!sectionVM.launchable || !sectionVM.setId) {
    return (
      <PageShell nav={false} width="measure">
        <PageHeader
          title={SECTION_LABEL[sectionVM.section]}
          lede={
            isTerminalSection(sectionVM.state)
              ? "This section of the Full-Test Run is already finished."
              : !sectionVM.setId
                ? "No Set was available for this section when the Full-Test Run was created."
                : !sectionVM.runnable
                  ? NOT_RUNNABLE
                  : "This Full-Test Run is not at this section yet: the sections run in the order ETS gives them."
          }
          actions={
            <Button variant="primary" onClick={() => navigate(`/full-test/${run.id}`)}>
              Back to the Full-Test Run
            </Button>
          }
        />
      </PageShell>
    );
  }

  // Each section is the same Simulation /simulate/:kind mounts, given the Run's Set and any Attempt
  // the Run already links through `fullTest`.
  const context = { runId: run.id, setId: sectionVM.setId, attemptId: sectionVM.attemptId };
  switch (sectionVM.section) {
    case "reading":
      return <ReadingSimulation fullTest={context} />;
    case "listening":
      return <ListeningSimulation fullTest={context} />;
    case "writing":
      return <WritingSimulation fullTest={context} />;
    case "speaking":
      return <SpeakingSimulation fullTest={context} />;
  }
}
