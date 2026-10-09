import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { reportError } from '../core/errors';

interface Props {
  children: React.ReactNode;
  scope?: string;
  /** Render a compact fallback inside a view instead of the full-page one. */
  inline?: boolean;
  resetKey?: string | number;
}
interface State {
  error: Error | null;
}

/**
 * Catches render errors so one broken module never blanks the whole CRM.
 * Logs through the central error reporter (which forwards to the server error log).
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportError(this.props.scope || 'render', error, { componentStack: info.componentStack?.slice(0, 800) });
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const msg = this.state.error.message || 'Unexpected error';
    if (this.props.inline) {
      return (
        <div className="m-6 p-5 rounded-xl border border-[#B06A55]/40 bg-[#FAF0EC] text-[#8A3E28]">
          <div className="flex items-center gap-2 font-bold text-sm"><AlertTriangle size={18} /> This section hit an error</div>
          <p className="text-xs mt-1 break-words">{msg}</p>
          <button onClick={() => this.setState({ error: null })} className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-[#B06A55]/40 text-xs font-semibold">
            <RefreshCw size={12} /> Try again
          </button>
        </div>
      );
    }
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F2F7FB] p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border border-[#D3E3F0] p-6 shadow-lg text-center">
          <div className="w-12 h-12 rounded-2xl bg-[#FAF0EC] text-[#8A3E28] flex items-center justify-center mx-auto mb-3"><AlertTriangle size={22} /></div>
          <h2 className="text-lg font-bold text-[#0B2A44]">Something went wrong</h2>
          <p className="text-xs text-[#5E778C] mt-2 break-words">{msg}</p>
          <p className="text-[11px] text-[#7E93A6] mt-2">The error has been logged. Your data is safe on the CRM server.</p>
          <button onClick={() => window.location.reload()} className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0B2A44] text-white text-xs font-semibold">
            <RefreshCw size={13} /> Reload CRM
          </button>
        </div>
      </div>
    );
  }
}
