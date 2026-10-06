import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

class RecoveryBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="recovery">
          <h1>Prospero needs a fresh start</h1>
          <p>Your saved conversations are still on this computer.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload Prospero
          </button>
        </main>
      );
    return this.props.children;
  }
}
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <React.StrictMode>
      <RecoveryBoundary>
        <App />
      </RecoveryBoundary>
    </React.StrictMode>,
  );
