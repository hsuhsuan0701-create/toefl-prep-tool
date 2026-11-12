import { MODULE_PATH_LABEL } from "../ui/labels";

export type ModulePathDisclosureProps = {
  modulePath: "lower" | "upper" | null | undefined;
};

// Wherever a routed Attempt's Band Estimate appears, its Module Path appears with it, and on the
// Lower Module, the cap on its band. One component, so every surface carries the same tested wording
// and a weakened or dropped cap sentence fails a test instead of shipping.
//
// Both the Promotion Threshold (implied by "routed") and the 4.5 Lower Module cap are this project's
// assumptions, never ETS policy (ROUTER_PROMOTION_THRESHOLD in server/src/services/moduleRouter.ts,
// LOWER_PATH_BAND_CAP in server/src/services/bandEstimator.ts). `modulePath` accepts null or
// undefined so callers can pass a view model's field straight through; it renders nothing for
// either.
export default function ModulePathDisclosure({ modulePath }: ModulePathDisclosureProps) {
  if (!modulePath) return null;

  return (
    <p data-testid="module-path-disclosure" className="text-meta text-graphite text-pretty">
      <span className="font-medium text-ink-soft">Module Path: </span>
      {MODULE_PATH_LABEL[modulePath]}
      {modulePath === "lower" && (
        <span>
          {" "}— the Lower Module path's Band Estimate is capped at 4.5, our own assumption, not published
          ETS policy.
        </span>
      )}
    </p>
  );
}
