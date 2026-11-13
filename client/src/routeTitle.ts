import { useEffect } from "react";
import { matchRoutes, useMatches, type Params, type RouteObject } from "react-router-dom";
import { SECTION_LABEL } from "./ui/labels";
import type { Section } from "@toefl-prep/shared";

export const APP_TITLE = "TOEFL Prep Tool";

/**
 * A route's page name for the document title, set on the route's `handle` in App.tsx's route table.
 * A function gets the route's params, for a route whose page name depends on them
 * ("Reading Simulation"). It names the page only, in CONTEXT.md's terms: never a Set title or other
 * content, which a Simulation keeps for its own screens.
 */
export type RouteTitle = string | ((params: Params) => string);
export type RouteHandle = { title: RouteTitle };

/** "Progress" becomes "Progress · TOEFL Prep Tool": the page first, so tabs and history differ. */
export function documentTitle(page: string): string {
  return `${page} · ${APP_TITLE}`;
}

export function resolveRouteTitle(title: RouteTitle, params: Params): string {
  return typeof title === "function" ? title(params) : title;
}

/** A section's label for a `:kind` or `:section` param, or null when the param names no section. */
export function sectionParamLabel(param: string | undefined): string | null {
  return param && Object.hasOwn(SECTION_LABEL, param) ? SECTION_LABEL[param as Section] : null;
}

function routeHandleTitle(handle: unknown): RouteTitle | null {
  if (typeof handle !== "object" || handle === null || !("title" in handle)) return null;
  const { title } = handle as { title: unknown };
  return typeof title === "string" || typeof title === "function" ? (title as RouteTitle) : null;
}

/** The page name of the deepest matched route that names one. */
function deepestTitle(matches: readonly { handle?: unknown; route?: { handle?: unknown }; params: Params }[]): string | null {
  for (let i = matches.length - 1; i >= 0; i--) {
    const title = routeHandleTitle(matches[i].handle ?? matches[i].route?.handle);
    if (title !== null) return resolveRouteTitle(title, matches[i].params);
  }
  return null;
}

/** The page name `routes` give `path` ("/progress" is "Progress"), or null when none matches. */
export function pageTitleFor(routes: RouteObject[], path: string): string | null {
  return deepestTitle(matchRoutes(routes, path) ?? []);
}

/**
 * Sets the document title from the deepest matched route that names one. Called once, in the root
 * route, so every page gets its title from the route table and none sets its own. It follows the
 * router's matches, so a link, Back and Forward all update it.
 */
export function useRouteDocumentTitle(): void {
  const page = deepestTitle(useMatches());
  useEffect(() => {
    if (page !== null) document.title = documentTitle(page);
  }, [page]);
}
