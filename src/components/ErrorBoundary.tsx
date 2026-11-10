import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

/** Catches render-time exceptions in a subtree and shows a calm message,
 * so one broken view (e.g. a chart) can't blank the whole app. */
export default class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("View crashed:", error);
  }

  render() {
    if (this.state.failed) {
      return (
        <p className="text-sm text-zinc-500">
          Something went wrong drawing this view — the rest of the app is fine.
          Close and reopen the tab to retry.
        </p>
      );
    }
    return this.props.children;
  }
}
