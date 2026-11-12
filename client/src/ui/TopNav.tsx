import { NavLink } from "react-router-dom";
import { cx } from "./cx";

export type TopNavLink = { to: string; label: string; end?: boolean };

type TopNavProps = {
  brand: string;
  links: TopNavLink[];
};

/**
 * The bar across the top of the planning pages: the app's name and its top-level pages. A ruled
 * line, no fill — it sits on the page's paper. The current page is marked by weight, ink colour and
 * an accent rule under it (three signals, so never colour alone). Exam screens never render it;
 * use ExamShell there. Pages do not render this directly: AppNav owns the link list.
 */
export function TopNav({ brand, links }: TopNavProps) {
  return (
    <header className="border-b border-rule">
      <div className="mx-auto flex max-w-page flex-wrap items-center gap-x-8 px-gutter">
        <span className="py-3 font-serif text-heading font-semibold whitespace-nowrap text-ink sm:py-0">{brand}</span>
        <nav aria-label="Main" className="-mx-2 min-w-0 basis-full sm:mx-0 sm:basis-auto sm:flex-1">
          <ul className="flex overflow-x-auto">
            {links.map((link) => (
              <li key={link.to}>
                <NavLink
                  to={link.to}
                  end={link.end}
                  className={({ isActive }) =>
                    cx(
                      "relative inline-flex min-h-12 items-center px-2 text-ui whitespace-nowrap transition-colors duration-(--duration-quick) sm:px-3",
                      "focus-visible:-outline-offset-2",
                      isActive
                        ? "font-semibold text-ink after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-accent sm:after:inset-x-3"
                        : "text-ink-soft hover:text-ink",
                    )
                  }
                >
                  {link.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}
