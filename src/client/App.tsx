import React, { useState, useEffect } from 'react';
import CoachView from './views/CoachView';
import DisplayView from './views/DisplayView';
import HistoryView from './views/HistoryView';

export default function App() {
  const [route, setRoute] = useState<string>(window.location.pathname);

  useEffect(() => {
    const handlePopState = () => setRoute(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = (path: string) => {
    window.history.pushState({}, '', path);
    setRoute(path);
  };

  // Basic manual routing
  if (route.startsWith('/coach/')) {
    const sessionId = route.split('/coach/')[1];
    return <CoachView sessionId={sessionId} onNavigate={navigate} />;
  }

  if (route.startsWith('/display/')) {
    const sessionId = route.split('/display/')[1];
    return <DisplayView sessionId={sessionId} onNavigate={navigate} />;
  }

  return <HistoryView onNavigate={navigate} />;
}
