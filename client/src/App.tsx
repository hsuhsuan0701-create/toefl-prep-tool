import { lazy, Suspense } from "react";
import { createBrowserRouter, Outlet, RouterProvider, type RouteObject } from "react-router-dom";
import AppErrorBoundary from "./components/AppErrorBoundary";
import LeaveGuardHost from "./components/LeaveGuardHost";
import RouteFallback from "./components/RouteFallback";

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
const routes: RouteObject[] = [
  { path: "/", element: <Dashboard /> },
  { path: "/progress", element: <Progress /> },
  { path: "/sets", element: <Sets /> },
  // Backward buildup practice. Keeps AppNav: it is not an Attempt (DrillLab.tsx).
  { path: "/drill-lab", element: <DrillLab /> },
  { path: "/writing/:setId", element: <WritingDrill /> },
  { path: "/speaking/:setId", element: <SpeakingDrill /> },
  { path: "/reading/:setId", element: <ReadingDrill /> },
  { path: "/listening/:setId", element: <ListeningDrill /> },
  { path: "/attempts/:id", element: <AttemptReview /> },
  { path: "/simulate/:kind", element: <SimulationRun /> },
  { path: "/full-test/:runId", element: <FullTestRun /> },
  // Launches one section's own Simulation on the Set the Run drew for it.
  { path: "/full-test/:runId/:section", element: <FullTestSectionRun /> },
  // The design system's living reference, for contributors (docs/design-system.md).
  { path: "/design-preview", element: <DesignPreview /> },
];

// Every route renders inside the app's error boundary. It has to sit inside the router: a boundary
// placed around <RouterProvider> never sees a route's render error, because the router catches it
// first and shows its own default error page. LeaveGuardHost sits there too: it draws the one
// "Leave …?" dialog every running Drill and Simulation asks through.
const router = createBrowserRouter([
  {
    element: (
      <AppErrorBoundary>
        <LeaveGuardHost>
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </LeaveGuardHost>
      </AppErrorBoundary>
    ),
    children: routes,
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
