import { Component, type ReactNode } from 'react';

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Keep console signal for debugging.
    // eslint-disable-next-line no-console
    console.error(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen p-8 bg-gradient-to-br from-slate-50 via-white to-slate-100">
        <div className="max-w-3xl mx-auto rounded-3xl border border-red-200 bg-white shadow-xl p-6 space-y-3">
          <p className="text-slate-900 font-medium">Something went wrong</p>
          <p className="text-sm text-slate-600">
            Open DevTools Console for details. If you share the error message here, I’ll fix it.
          </p>
          <pre className="text-xs whitespace-pre-wrap rounded-2xl bg-red-50 border border-red-100 p-4 text-red-700">
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm text-slate-800"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}

