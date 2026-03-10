import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state: { hasError: boolean };
  props: { children: React.ReactNode };

  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.props = props;
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error('应用错误:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#111', color: '#fff', gap: '16px' }}>
          <p style={{ fontSize: '16px', color: '#aaa' }}>页面渲染出错，请刷新重试</p>
          <p style={{ fontSize: '13px', color: '#666' }}>提示：请关闭浏览器翻译插件后重试</p>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: '8px 24px', background: '#6d28d9', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px' }}
          >
            刷新页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
