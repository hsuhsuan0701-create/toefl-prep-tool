import type { ReactNode } from "react";
import AppNav from "../components/AppNav";
import { cx } from "./cx";

type PageShellProps = {
  children: ReactNode;
  /** `page` (default) for planning screens; `measure` for a single column of reading (a report). */
  width?: "page" | "measure";
  /**
   * Show the top navigation (default). Off only for a reading page that sits between exam screens
   * — a Full-Test Run between sections — where a nav bar is an invitation to leave mid-sitting.
   */
  nav?: boolean;
};

/**
 * Every planning and reading page: Dashboard, Progress, Sets, Drill Lab, Attempt review, a
 * Full-Test Run's report. The top navigation, a skip link, and one centred column with the
 * standard gutter. Exam screens (Drills, Simulations, Full-Test sections) use ExamShell instead and
 * never show the navigation.
 */
export function PageShell({ children, width = "page", nav = true }: PageShellProps) {
  return (
    <>
      <a
        href="#main"
        className="sr-only rounded-control bg-accent px-3 py-2 text-ui font-medium text-on-accent focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
      >
        Skip to content
      </a>
      {nav && <AppNav />}
      <main id="main" className={cx("mx-auto w-full px-gutter pt-8 pb-20 sm:pt-10", width === "page" ? "max-w-page" : "max-w-measure")}>
        {children}
      </main>
    </>
  );
}
