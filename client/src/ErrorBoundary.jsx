import React from "react";

// If any part of the app crashes, show what happened instead of a blank screen.
export default class ErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Matinée crashed:", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="gate">
        <div className="gate-card">
          <span className="logo">Matinée<span className="logo-dot">●</span></span>
          <h2>The projector jammed</h2>
          <p>Something went wrong on this page. Reloading usually fixes it.</p>
          <pre className="crash-msg">{String(this.state.error?.message || this.state.error)}</pre>
          <button className="btn btn-primary btn-lg" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
