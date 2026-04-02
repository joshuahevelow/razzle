import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

import AuthPage from "./pages/AuthPage";
import Lobby from "./pages/Lobby";
import Game from "./pages/Game";

export default function App() {
  const [user, setUser] = useState(null);
  const [gameId, setGameId] = useState(null);

  useEffect(() => {
    const loadUser = async () => {
      const { data } = await supabase.auth.getUser()
      setUser(data.user ?? null)
    }

    loadUser()

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })

    return () => subscription.unsubscribe()
  }, []);

  if (!user) return <AuthPage />;

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setGameId(null);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">Razzle</div>
        <div className="topbar-actions">
          <span className="user-label">{user.email}</span>
          <button className="button secondary" onClick={handleSignOut}>
            Sign Out
          </button>
        </div>
      </header>
      {gameId ? (
        <Game gameId={gameId} user={user} onLeave={() => setGameId(null)} />
      ) : (
        <Lobby user={user} setGameId={setGameId} />
      )}
    </div>
  );
}