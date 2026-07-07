import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import "./styles.css";

// NOTE: `React.StrictMode` causes double-mounting of components in dev which
// can surface issues where an effect accidentally returns a Promise. To make
// debugging easier, render without StrictMode for now and rely on the
// `ErrorBoundary` to capture uncaught exceptions. Re-enable StrictMode after
// the root cause is fixed.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
