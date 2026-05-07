import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { auth, googleProvider } from '../services/firebase';

interface AuthContextType {
  user: User | null;
  token: string | null;
  role: string | null;
  loading: boolean;
  authError: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  token: null,
  role: null,
  loading: true,
  authError: null,
  login: async () => {},
  logout: async () => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setAuthError(null);
      
      if (currentUser) {
        try {
          const t = await currentUser.getIdToken();
          const res = await fetch('/api/auth/verify', {
            headers: { Authorization: `Bearer ${t}` }
          });
          
          if (!res.ok) {
            // User is authenticated in Firebase, but NOT in our DB allowlist
            await signOut(auth);
            setUser(null);
            setToken(null);
            setRole(null);
            setAuthError("This Google account is not authorized for Coach access.");
          } else {
            // User is fully authorized
            const data = await res.json() as { ok: boolean, email: string, role: string };
            setToken(t);
            setRole(data.role);
            setUser(currentUser);
          }
        } catch (error) {
          console.error("Auth verification failed", error);
          await signOut(auth);
          setUser(null);
          setToken(null);
          setRole(null);
          setAuthError("Failed to verify authorization status.");
        }
      } else {
        setUser(null);
        setToken(null);
        setRole(null);
      }
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  // Set up token refresh in background
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(async () => {
      const t = await user.getIdToken(true);
      setToken(t);
    }, 1000 * 60 * 10); // Refresh every 10 min
    return () => clearInterval(interval);
  }, [user]);

  const login = async () => {
    await signInWithPopup(auth, googleProvider);
  };

  const logout = async () => {
    await signOut(auth);
    setAuthError(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, role, loading, authError, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
