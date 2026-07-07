import React from "react";

type State = { error: Error | null };

export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: any) {
    // Log to console; consumers may replace with a logging service.
    // Keep this minimal and safe for the dev environment.
    // eslint-disable-next-line no-console
    console.error("Unhandled UI error:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20 }}>
          <h2>Something went wrong</h2>
          <pre style={{ whiteSpace: "pre-wrap" }}>{String(this.state.error?.message)}</pre>
          <p>Please check the developer console for a full stack trace.</p>
        </div>
      );
    }
    return this.props.children as any;
  }
}
