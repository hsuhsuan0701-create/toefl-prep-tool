// Router Module -> Lower/Upper Module routing for a Reading or Listening Simulation, Full-Test Run
// sections included. Pure: POST /api/attempts/:id/route calls decidePath once every Router Module
// Item is scored and persists the result onto attempts.module_path and attempts.router_raw. Drills
// never route; they only ever take the Router Module (ADR 0005).

/**
 * The Promotion Threshold: the Router Module raw fraction at or above which an Attempt routes to the
 * Upper Module. Our assumption, not ETS policy: ETS discloses no routing rule. ADR 0005, "Routing
 * threshold", has the derivation. It comes from third-party analyses of the digital SAT's module-2
 * routing point (about 55-70% correct) and lines up with Table 3: Reading band 4.0, the B2 floor,
 * starts at 18/30, exactly 60% (Listening's at 17/30, about 57%). One value serves both sections
 * because that spread is below one Router Item's noise.
 *
 * Reading Routers carry moderate texts only, so the same ability scores higher on them than on a
 * mixed-difficulty Router, and 0.6 is a slightly easier bar than when it was derived. A retune must
 * be calibrated against routing data from moderate-only Routers.
 */
export const ROUTER_PROMOTION_THRESHOLD = 0.6;

/**
 * Decides which second module a Router Module score routes an Attempt to. `routerRaw` is returned
 * unrounded so the caller persists exactly the fraction that decided the path. `totalCount` must be
 * positive: (0, 0) yields a NaN routerRaw, which censusRouterItems rules out.
 *
 * `>=`, not `>`: exactly 0.6 routes upper, because Table 3's band-4.0 boundary is an inclusive floor
 * ("starts at 18/30").
 */
export function decidePath(correctCount: number, totalCount: number): { path: "lower" | "upper"; routerRaw: number } {
  const routerRaw = correctCount / totalCount;
  const path = routerRaw >= ROUTER_PROMOTION_THRESHOLD ? "upper" : "lower";
  return { path, routerRaw };
}
