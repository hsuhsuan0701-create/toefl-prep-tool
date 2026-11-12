import { moduleTaskTypes, requiredTaskTypes, type Section } from "../../src/services/bandEstimator.js";

export type SittingItem = { itemId: string; taskType: string; scoreJson: string };

/** score_json as deterministic scoring tags a Reading or Listening Item with its Module. */
export function moduleScoreJson(module: "router" | "lower" | "upper"): string {
  return JSON.stringify({ module });
}

/**
 * One Item of every Task Type a section's band needs, as an Attempt that sat the whole section
 * holds them: the least an Attempt can carry and still have a band.
 *
 * Speaking and Writing: one per Task Type the section requires, `<taskType>-1`, score_json `{}`.
 * Reading and Listening: one per Task Type each Module taken carries (the Router Module, then the
 * one `modulePath` names), `<module>-<taskType>-1`, its score_json tagged with that Module. The band
 * rule asks each Module for its own Items, so an untagged row, or a Router Module alone, is short.
 */
export function wholeSittingItems(section: Section, modulePath: "lower" | "upper" = "upper"): SittingItem[] {
  if (section === "speaking" || section === "writing") {
    return requiredTaskTypes(section, null).map((taskType) => ({ itemId: `${taskType}-1`, taskType, scoreJson: "{}" }));
  }
  return (["router", modulePath] as const).flatMap((module) =>
    moduleTaskTypes(section, module).map((taskType) => ({
      itemId: `${module}-${taskType}-1`,
      taskType,
      scoreJson: moduleScoreJson(module),
    })),
  );
}
