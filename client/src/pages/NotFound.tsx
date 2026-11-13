import { useLocation } from "react-router-dom";
import { ButtonLink } from "../ui/Button";
import { PageHeader } from "../ui/Heading";
import { Notice } from "../ui/Notice";
import { PageShell } from "../ui/PageShell";

/**
 * A path no route matches (the route table's `*` route). It keeps the top navigation: an unknown
 * address is never an exam screen, and the nav is the way back to somewhere real. An id that does
 * not exist under a real path (`/attempts/<id>`, `/reading/<id>`) is that page's own business, not
 * this one's.
 */
export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <PageShell width="measure">
      <PageHeader title="Page not found" />
      <Notice
        tone="caution"
        action={
          <ButtonLink to="/" variant="primary" size="sm">
            Back to Practice
          </ButtonLink>
        }
      >
        <p>
          There is no page at <span className="font-mono">{pathname}</span>.
        </p>
      </Notice>
    </PageShell>
  );
}
