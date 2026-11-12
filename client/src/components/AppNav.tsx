import { TopNav } from "../ui/TopNav";

// The four top-level pages, and only those. Drills, Simulations and a Full-Test Run being sat render
// no AppNav (see App.tsx's route table): a nav bar there is an invitation to leave mid-Attempt.
// The look lives in ui/TopNav.tsx; this file owns only which pages are top-level.
const LINKS = [
  { to: "/", label: "Practice", end: true },
  { to: "/progress", label: "Progress", end: false },
  { to: "/sets", label: "Sets", end: false },
  { to: "/drill-lab", label: "Drill Lab", end: false },
];

export default function AppNav() {
  return <TopNav brand="TOEFL Prep Tool" links={LINKS} />;
}
