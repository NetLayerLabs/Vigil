import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { Landing } from './Landing';
import './index.css';
import './theme.css';

export const APP_PATH = '/app';

function usePathname(): string {
  const [pathname, setPathname] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return pathname;
}

export function navigate(path: string) {
  if (window.location.pathname === path) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0 });
}

function Root() {
  const pathname = usePathname();
  const isApp = pathname === APP_PATH || pathname.startsWith(`${APP_PATH}/`);
  if (isApp) {
    return <App onHome={() => navigate('/')} />;
  }
  return <Landing onLaunch={() => navigate(APP_PATH)} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
