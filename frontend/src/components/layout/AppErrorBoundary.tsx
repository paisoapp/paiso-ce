import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { PaisoMark } from "@/components/brand/PaisoLogo";
import { isMissingBuildFile, reloadForNewBuild } from "@/lib/staleBuild";

type Failure = "none" | "reloading" | "new-build" | "error";

interface Props {
  /** Changes when the visitor moves to another page, which clears the error. */
  resetKey: string;
  children: ReactNode;
}

/** Catches what would otherwise leave the whole screen blank.
 *
 *  The usual cause is a tab that outlived a deploy and asked for a page the
 *  new build no longer has (see lib/staleBuild.ts): that reloads once without
 *  asking. Anything else, or a reload that did not help, gets a screen that
 *  says so and offers the reload. */
class Boundary extends Component<Props, { failure: Failure }> {
  state: { failure: Failure } = { failure: "none" };

  static getDerivedStateFromError(error: unknown): { failure: Failure } {
    if (!isMissingBuildFile(error)) return { failure: "error" };
    return { failure: reloadForNewBuild() ? "reloading" : "new-build" };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Paiso could not draw this page", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.failure !== "none") {
      this.setState({ failure: "none" });
    }
  }

  render() {
    const { failure } = this.state;
    if (failure === "none") return this.props.children;
    if (failure === "reloading") {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      );
    }
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <PaisoMark className="h-14 w-14" />
        <h1 className="text-lg font-semibold text-foreground">
          {failure === "new-build" ? "Paiso has been updated" : "This page could not load"}
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {failure === "new-build"
            ? "Reload to get the latest version. Your data is safe."
            : "Something went wrong on our side. Your data is safe. Reload the page to try again."}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ring"
        >
          Reload
        </button>
      </div>
    );
  }
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <Boundary resetKey={pathname}>{children}</Boundary>;
}
