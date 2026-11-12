import { Component, type ErrorInfo, type ReactNode } from "react";

type State = { error: Error | null };

/**
 * The app's one error boundary. App.tsx renders every route inside it (a boundary outside the data
 * router would never see a route's render error), and main.tsx wraps the router in it as well, for
 * a failure in the router itself.
 *
 * React unmounts the entire root when a render throws, and some renderers throw on purpose when
 * data breaks an invariant (a chart row that should exist, an exhaustive switch). Without this a
 * single bad Attempt or Set leaves a blank page. The fallback names the error and offers a full
 * reload of Practice — a plain link rather than a router link, because the router may be what
 * failed.
 *
 * Browser Back/Forward clears the error, so leaving the broken page by history works as expected.
 */
export default class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Unhandled error while rendering the page", error, info.componentStack);
  }

  componentDidMount() {
    window.addEventListener("popstate", this.reset);
  }

  componentWillUnmount() {
    window.removeEventListener("popstate", this.reset);
  }

  reset = () => {
    if (this.state.error) this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // Tokens and plain elements only: the primitives may be what failed.
    return (
      <main role="alert" className="mx-auto flex min-h-dvh w-full max-w-measure flex-col justify-center gap-4 bg-paper px-gutter py-16">
        <h1 className="font-serif text-title font-semibold text-ink">Something went wrong on this page</h1>
        <p className="text-body text-ink-soft">
          The page hit an error it couldn't recover from. Your saved Attempts and scores are not affected.
        </p>
        <pre className="overflow-x-auto rounded-control border border-rule bg-well p-3 font-mono text-meta whitespace-pre-wrap text-ink-soft">
          {error.message}
        </pre>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={this.reset}
            className="min-h-10 rounded-control border border-rule-strong bg-sheet px-4 text-ui font-medium text-ink hover:border-graphite"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex min-h-10 items-center rounded-control bg-accent px-4 text-ui font-medium text-on-accent hover:bg-accent-strong"
          >
            Back to Practice
          </a>
        </div>
      </main>
    );
  }
}
