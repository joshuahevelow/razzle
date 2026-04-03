import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

import AuthPage from "./pages/AuthPage";
import Lobby from "./pages/Lobby";
import Game from "./pages/Game";

// Email that sees the admin message box. Set to the address when ready.
const ADMIN_EMAIL = import.meta.env.VITE_SPECIAL_EMAIL;

export default function App() {
  const [user, setUser] = useState(null);
  const [gameId, setGameId] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [history, setHistory] = useState(null); // null = not loaded yet
  const [profile, setProfile] = useState(null);

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

  useEffect(() => {
    if (!user) { setProfile(null); return; }
    supabase.from("profiles").select("username").eq("id", user.id).single().then(({ data }) => {
      setProfile(data ?? null);
    });
  }, [user?.id]);

  const openHistory = async () => {
    setShowHistory(true);
    if (history !== null) return;
    const me = user?.id;
    const { data: all } = await supabase.from("games").select("players, scores, targetScore, senderEmail, inviteEmail");
    if (!all) { setHistory([]); return; }
    const opponentMap = {};
    for (const g of all) {
      if (!g.players?.includes(me)) continue;
      const target = g.targetScore || 5;
      const oppId = g.players.find(id => id !== me);
      if (!oppId) continue;
      const winner = g.players.find(id => (g.scores?.[id] ?? 0) >= target);
      if (!winner) continue;
      if (!opponentMap[oppId]) {
        opponentMap[oppId] = {
          oppId,
          fallbackName: g.players[0] === me ? (g.inviteEmail || "Unknown") : (g.senderEmail || "Unknown"),
          wins: 0,
          losses: 0
        };
      }
      if (winner === me) opponentMap[oppId].wins++;
      else opponentMap[oppId].losses++;
    }
    const oppIds = Object.keys(opponentMap);
    const profData = oppIds.length > 0
      ? ((await supabase.from("profiles").select("id, username").in("id", oppIds)).data || [])
      : [];
    const profMap = Object.fromEntries(profData.map(p => [p.id, p.username]));
    setHistory(
      Object.values(opponentMap)
        .map(o => ({ name: profMap[o.oppId] || o.fallbackName, wins: o.wins, losses: o.losses }))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  };

  if (!user) return <AuthPage />;

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setGameId(null);
    setHistory(null);
  };

  const isAdmin = ADMIN_EMAIL && user.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  console.log(isAdmin);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">Razzle</div>
        <div className="topbar-actions">
          <span className="user-label">{profile?.username || user.email}</span>
          <button className="button icon-btn" onClick={openHistory} title="Game History">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9H3V3h18v6h-3"/>
              <path d="M6 2v7c0 3.31 2.69 6 6 6s6-2.69 6-6V2"/>
              <path d="M12 15v4"/>
              <path d="M8 19h8"/>
            </svg>
          </button>
          {isAdmin && (
            <button className="button icon-btn" onClick={() => setShowAdmin(true)} title="Letter">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2"/>
                <polyline points="2,4 12,13 22,4"/>
              </svg>
            </button>
          )}
          <button className="button secondary" onClick={handleSignOut}>
            Sign Out
          </button>
        </div>
      </header>

      {showHistory && (
        <div className="modal-backdrop" onClick={() => setShowHistory(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Game History</h2>
              <button className="modal-close" onClick={() => setShowHistory(false)}>✕</button>
            </div>

            {history === null ? (
              <p className="history-loading">Loading…</p>
            ) : history.length === 0 ? (
              <p className="history-empty">No completed games yet.</p>
            ) : (
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Opponent</th>
                    <th>Wins</th>
                    <th>Losses</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(row => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td className="stat-win">{row.wins}</td>
                      <td className="stat-loss">{row.losses}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {showAdmin && (
        <div className="modal-backdrop" onClick={() => setShowAdmin(false)}>
          <div className="modal-card modal-card--wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Happy Birthday</h2>
              <button className="modal-close" onClick={() => setShowAdmin(false)}>✕</button>
            </div>
            <div className="admin-message-box">
              <p>Dear Mom,<br/><br/>

{import.meta.env.VITE_BIRTHDAY_MESSAGE}

<br/><br/>Love,<br/>Josh</p>
            </div>
          </div>
        </div>
      )}

      {gameId ? (
        <Game gameId={gameId} user={user} onLeave={() => { setGameId(null); setHistory(null); }} />
      ) : (
        <Lobby user={user} setGameId={setGameId} profile={profile} />
      )}
    </div>
  );
}