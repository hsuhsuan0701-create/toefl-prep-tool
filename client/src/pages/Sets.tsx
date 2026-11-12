import { useSearchParams } from "react-router-dom";
import SetSection from "../components/SetSection";
import UnloadableSetsNotice from "../components/UnloadableSetsNotice";
import { SECTION_ROUTES, useSetBanks, useUnloadableSets, type PracticeSection } from "../hooks/usePracticeData";
import { ButtonLink } from "../ui/Button";
import { PageHeader } from "../ui/Heading";
import { PageShell } from "../ui/PageShell";
import { Tabs } from "../ui/Segmented";

// Test order, as everywhere a page lists the four sections.
const SECTIONS: PracticeSection[] = ["reading", "listening", "writing", "speaking"];

function isSection(value: string | null): value is PracticeSection {
  return value !== null && (SECTIONS as string[]).includes(value);
}

// The full Set bank, one section at a time: a section holds dozens of Sets, and all four stacked
// would make the page several thousand pixels tall on a phone. The open section lives in the URL
// (?section=writing), so a link can open the bank on a section and Back returns to it. With none
// named, the page opens on the first section, in test order, that has any Sets.
export default function Sets() {
  const practice = useSetBanks();
  // The Set files that failed to load. They are reported here because this page claims to show
  // every Set.
  const unloadable = useUnloadableSets();
  const [params, setParams] = useSearchParams();

  const requested = params.get("section");
  const selected = isSection(requested)
    ? requested
    : (SECTIONS.find((section) => (practice.sets[section]?.length ?? 0) > 0) ?? SECTIONS[0]);

  return (
    <PageShell>
      <PageHeader title="Sets" lede="Every Set in your bank. Open one to Drill it, or start a Simulation on the next new Set." />
      <div className="space-y-6">
        <UnloadableSetsNotice unloadable={unloadable} />
        <Tabs
          label="Section"
          value={selected}
          onChange={(id) => setParams({ section: id }, { replace: true })}
          items={SECTIONS.map((section) => {
            const sets = practice.sets[section];
            return {
              id: section,
              label: (
                <span className="inline-flex items-baseline gap-1.5">
                  {SECTION_ROUTES[section].label}
                  {sets && <span className="figures text-meta font-normal text-graphite">{sets.length}</span>}
                </span>
              ),
              panel: (
                <SetSection
                  title={`${SECTION_ROUTES[section].label} Sets`}
                  linkBase={SECTION_ROUTES[section].linkBase}
                  simulateHref={SECTION_ROUTES[section].simulateHref}
                  sets={sets}
                  error={practice.errors[section]}
                  onRetry={practice.reload}
                  emptyAction={
                    <ButtonLink to="/" size="sm">
                      Generate Sets on Practice
                    </ButtonLink>
                  }
                />
              ),
            };
          })}
        />
      </div>
    </PageShell>
  );
}
