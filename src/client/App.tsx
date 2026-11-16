import React, { useState, useEffect } from 'react';
import CoachView from './views/CoachView';
import DisplayView from './views/DisplayView';
import HistoryView from './views/HistoryView';
import AdminView from './views/AdminView';
import HowzatView from './views/HowzatView';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import LoginView from './views/LoginView';

function AppRoutes() {
  const [route, setRoute] = useState<string>(window.location.pathname);
  const { user, loading } = useAuth();

  useEffect(() => {
    // Firebase Auth permits 'localhost' by default, not '127.0.0.1'
    if (window.location.hostname === '127.0.0.1') {
      const target = window.location.href.replace('://127.0.0.1', '://localhost');
      window.location.replace(target);
      return;
    }
    const handlePopState = () => setRoute(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = (path: string) => {
    window.history.pushState({}, '', path);
    setRoute(path);
  };

  // Standalone Howzat Studio & Display View are accessible without requiring Google Sign-In
  if (route === '/howzat') {
    return <HowzatView onNavigate={navigate} />;
  }

  if (route.startsWith('/display/')) {
    const sessionId = route.split('/display/')[1];
    return <DisplayView sessionId={sessionId} onNavigate={navigate} />;
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-[#071327]">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-slate-800 border-t-emerald-500 shadow-lg"></div>
        <p className="mt-6 text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Authenticating</p>
      </div>
    );
  }

  // All other views require authentication
  if (!user) {
    return <LoginView onNavigate={navigate} />;
  }

  if (route.startsWith('/coach/')) {
    const sessionId = route.split('/coach/')[1];
    return <CoachView sessionId={sessionId} onNavigate={navigate} />;
  }

  if (route === '/admin') {
    return <AdminView onNavigate={navigate} />;
  }

  if (route === '/howzat') {
    return <HowzatView onNavigate={navigate} />;
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
