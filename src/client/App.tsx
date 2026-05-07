import React, { useState, useEffect } from 'react';
import CoachView from './views/CoachView';
import DisplayView from './views/DisplayView';
import HistoryView from './views/HistoryView';
import AdminView from './views/AdminView';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import LoginView from './views/LoginView';

function AppRoutes() {
  const [route, setRoute] = useState<string>(window.location.pathname);
  const { user, loading } = useAuth();

  useEffect(() => {
    const handlePopState = () => setRoute(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = (path: string) => {
    window.history.pushState({}, '', path);
    setRoute(path);
  };

  if (loading) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-[#071327]">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-slate-800 border-t-emerald-500 shadow-lg"></div>
        <p className="mt-6 text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Authenticating</p>
      </div>
    );
  }

  // Display View is public (no authentication required)
  if (route.startsWith('/display/')) {
    const sessionId = route.split('/display/')[1];
    return <DisplayView sessionId={sessionId} onNavigate={navigate} />;
  }

  // All other views require authentication
  if (!user) {
    return <LoginView />;
  }

  if (route.startsWith('/coach/')) {
    const sessionId = route.split('/coach/')[1];
    return <CoachView sessionId={sessionId} onNavigate={navigate} />;
  }

  if (route === '/admin') {
    return <AdminView onNavigate={navigate} />;
  }

  return <HistoryView onNavigate={navigate} />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
