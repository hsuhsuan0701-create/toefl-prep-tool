import { lazy, Suspense, useEffect } from "react";
import { createBrowserRouter, isRouteErrorResponse, Outlet, RouterProvider, useRouteError, type RouteObject } from "react-router-dom";
import AppErrorBoundary, { PageErrorScreen } from "./components/AppErrorBoundary";
import LeaveGuardHost from "./components/LeaveGuardHost";
import RouteFallback from "./components/RouteFallback";
import { SetupStatusProvider } from "./components/setup/SetupStatusProvider";
import NotFound from "./pages/NotFound";
import { documentTitle, sectionParamLabel, useRouteDocumentTitle, type RouteHandle } from "./routeTitle";

// Every page is its own chunk, loaded when its route is first visited, so the Dashboard does not
// ship the trend charts, Build a Sentence's drag-and-drop or any exam screen. The one Suspense
// boundary below covers them all; the router renders navigations as transitions, so moving between
// pages keeps the current one on screen until the next has loaded.
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Progress = lazy(() => import("./pages/Progress"));
const Sets = lazy(() => import("./pages/Sets"));
const DrillLab = lazy(() => import("./pages/DrillLab"));
const WritingDrill = lazy(() => import("./pages/WritingDrill"));
const SpeakingDrill = lazy(() => import("./pages/SpeakingDrill"));
const ReadingDrill = lazy(() => import("./pages/ReadingDrill"));
const ListeningDrill = lazy(() => import("./pages/ListeningDrill"));
const AttemptReview = lazy(() => import("./pages/AttemptReview"));
const SimulationRun = lazy(() => import("./pages/SimulationRun"));
const FullTestRun = lazy(() => import("./pages/FullTestRun"));
const FullTestSectionRun = lazy(() => import("./pages/FullTestSectionRun"));
const DesignPreview = lazy(() => import("./pages/DesignPreview"));

// A data router rather than <BrowserRouter>: a running Drill or Simulation holds in-app navigation
// (browser Back, a swipe, its own Exit) to ask first, and useBlocker only works inside one.
//
// No route here adds AppNav; each page draws its own through PageShell. The Drill and Simulation
// routes render none (they are ExamShell screens), and a Full-Test Run renders none while it is
// being sat: on an exam screen a nav bar is an invitation to leave mid-run.
//
// Every route names its page for the document title in `handle` (routeTitle.ts), applied once in
// AppRoot below: the type requires a title, and test/appRoutes.test.tsx walks the table for one.
type TitledRoute = RouteObject & { handle: RouteHandle };

const routes: TitledRoute[] = [
  { path: "/", handle: { title: "Practice" }, element: <Dashboard /> },
  { path: "/progress", handle: { title: "Progress" }, element: <Progress /> },
  { path: "/sets", handle: { title: "Sets" }, element: <Sets /> },
  // Backward buildup practice. Keeps AppNav: it is not an Attempt (DrillLab.tsx).
  { path: "/drill-lab", handle: { title: "Drill Lab" }, element: <DrillLab /> },
  { path: "/writing/:setId", handle: { title: "Writing Drill" }, element: <WritingDrill /> },
  { path: "/speaking/:setId", handle: { title: "Speaking Drill" }, element: <SpeakingDrill /> },
  { path: "/reading/:setId", handle: { title: "Reading Drill" }, element: <ReadingDrill /> },
  { path: "/listening/:setId", handle: { title: "Listening Drill" }, element: <ListeningDrill /> },
  { path: "/attempts/:id", handle: { title: "Attempt review" }, element: <AttemptReview /> },
  {
    path: "/simulate/:kind",
    handle: { title: ({ kind }) => `${sectionParamLabel(kind) ?? ""} Simulation`.trim() },
    element: <SimulationRun />,
  },
  { path: "/full-test/:runId", handle: { title: "Full-Test Run" }, element: <FullTestRun /> },
  // Launches one section's own Simulation on the Set the Run drew for it.
  {
    path: "/full-test/:runId/:section",
    handle: {
      title: ({ section }) => {
        const label = sectionParamLabel(section);
        return label ? `${label} Simulation · Full-Test Run` : "Full-Test Run";
      },
    },
    element: <FullTestSectionRun />,
  },
  // The design system's living reference, for contributors (docs/design-system.md).
  { path: "/design-preview", handle: { title: "Design preview" }, element: <DesignPreview /> },
  // Any other path. Without it the router answers a no-match with its own bare 404 page, which has
  // no navigation and no way back.
  { path: "*", handle: { title: "Page not found" }, element: <NotFound /> },
];

/**
 * The root route's error element. The boundary below catches a page's render error; this catches
 * what the router catches before it can (an error in the root route itself, or a loader's), so
 * that too ends on the app's error screen and never on the router's default page. The router keeps
 * the error until the next navigation, so "Try again" reloads.
 */
function RouteError() {
  const caught = useRouteError();
  // The root route is what failed, so its title may never have been set.
  useEffect(() => {
    document.title = documentTitle("Something went wrong");
  }, []);
  const error = isRouteErrorResponse(caught)
    ? new Error(`${caught.status} ${caught.statusText}`)
    : caught instanceof Error
      ? caught
      : new Error(String(caught));
  return <PageErrorScreen error={error} onRetry={() => window.location.reload()} />;
}

// Every route renders inside the app's error boundary. It has to sit inside the router: a boundary
// placed around <RouterProvider> never sees a route's render error, because the router catches it
// first. LeaveGuardHost sits there too: it draws the one "Leave …?" dialog every running Drill and
// Simulation asks through. The document title is set here, from the matched route's handle. The
// setup status the Speaking and Writing screens warn from is held here too, so moving between them
// keeps the last answer while a fresh one is asked for.
function AppRoot() {
  useRouteDocumentTitle();
  return (
    <AppErrorBoundary>
      <LeaveGuardHost>
        <SetupStatusProvider>
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </SetupStatusProvider>
      </LeaveGuardHost>
    </AppErrorBoundary>
  );
}

// Exported so a test mounts this same table in a memory router (test/appRoutes.test.tsx).
// oxlint-disable-next-line react/only-export-components -- the route table is data, not a component
export const appRoutes: RouteObject[] = [{ element: <AppRoot />, errorElement: <RouteError />, children: routes }];

// Created on first render rather than on import, so importing the route table starts no router.
let router: ReturnType<typeof createBrowserRouter> | undefined;

export default function App() {
  router ??= createBrowserRouter(appRoutes);
  return <RouterProvider router={router} />;
}
