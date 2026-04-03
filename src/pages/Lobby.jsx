import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabaseClient";

const DEFAULT_TARGET_SCORE = 5;

export default function Lobby({ setGameId, user, profile }) {
  const [games, setGames] = useState([]);
  const [targetScore, setTargetScore] = useState(String(DEFAULT_TARGET_SCORE));
  const [opponentEmail, setOpponentEmail] = useState("");
  const [error, setError] = useState("");
  const [profileMap, setProfileMap] = useState({});

  const me = user?.id;
  const myEmail = user?.email?.toLowerCase() || "";
  const lobbyChannelRef = useRef(null);

  useEffect(() => {
    if (!me) return;

    const loadGames = async () => {
      const { data, error } = await supabase.from("games").select("*");
      if (error) { console.error(error); return; }
      setGames(data || []);
    };

    loadGames();

    // Single channel with both postgres_changes (fallback/auth) and broadcast (instant cross-client)
    const channel = supabase
      .channel("lobby")
      .on("postgres_changes", { event: "*", schema: "public", table: "games" }, (payload) => {
        setGames((current) => {
          if (payload.eventType === "INSERT") {
            if (current.some((g) => g.id === payload.new.id)) return current;
            return [...current, payload.new];
          }
          if (payload.eventType === "UPDATE") return current.map((g) => g.id === payload.new.id ? payload.new : g);
          if (payload.eventType === "DELETE") {
            const deletedId = payload.old?.id;
            if (deletedId) return current.filter((g) => g.id !== deletedId);
            // REPLICA IDENTITY not set — re-fetch to sync
            supabase.from("games").select("*").then(({ data }) => { if (data) setGames(data); });
            return current;
          }
          return current;
        });
      })
      .on("broadcast", { event: "lobby-insert" }, ({ payload }) => {
        if (!payload?.game) return;
        setGames((current) => {
          if (current.some((g) => g.id === payload.game.id)) return current;
          return [...current, payload.game];
        });
      })
      .on("broadcast", { event: "lobby-delete" }, ({ payload }) => {
        if (!payload?.gameId) return;
        setGames((current) => current.filter((g) => g.id !== payload.gameId));
      })
      .on("broadcast", { event: "lobby-update" }, ({ payload }) => {
        if (!payload?.game) return;
        setGames((current) => current.map((g) => g.id === payload.game.id ? payload.game : g));
      })
      .subscribe();

    lobbyChannelRef.current = channel;

    return () => {
      lobbyChannelRef.current = null;
      channel.unsubscribe();
    };
  }, [me, myEmail]);

  useEffect(() => {
    const ids = [...new Set(games.flatMap(g => g.players || []))];
    if (ids.length === 0) return;
    supabase.from("profiles").select("id, username").in("id", ids).then(({ data }) => {
      if (!data) return;
      setProfileMap(Object.fromEntries(data.map(p => [p.id, p.username])));
    });
  }, [JSON.stringify(games.map(g => (g.players || []).join()))]);

  const opponentDisplay = (game) => {
    if (game.players?.[0] === me) {
      const oppId = game.players?.[1];
      return (oppId && profileMap[oppId]) || game.inviteEmail || "Opponent";
    }
    return profileMap[game.players?.[0]] || game.senderEmail || "Opponent";
  };

  const formatDate = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    const date = `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
    const hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    const h = hours % 12 || 12;
    return `${date}, ${h}:${minutes} ${ampm}`;
  };

  const createGame = async () => {
    const inviteEmail = opponentEmail.trim().toLowerCase();
    if (!inviteEmail || !inviteEmail.includes("@")) { setError("Enter a valid opponent email."); return; }
    if (inviteEmail === myEmail) { setError("You cannot invite yourself."); return; }
    const parsedTarget = parseInt(targetScore, 10);
    if (!parsedTarget || parsedTarget < 3 || parsedTarget > 10) { setError("Points to win must be between 3 and 10."); return; }
    setError("");

    const { data, error } = await supabase.from("games").insert({
      players: [me],
      scores: { [me]: 0 },
      targetScore: parsedTarget,
      position: 0,
      dice: [],
      phase: "invited",
      roundOpen: false,
      challenge: null,
      inviteEmail,
      senderEmail: myEmail,
      status: `Game invite sent to ${inviteEmail}.`
    }).select().single();

    if (error) { console.error(error); setError("Could not create game. Try again."); return; }
    setGames((prev) => [...prev, data]);
    lobbyChannelRef.current?.send({ type: "broadcast", event: "lobby-insert", payload: { game: data } });
    setOpponentEmail("");
  };

  const cancelInvite = async (game) => {
    setGames((prev) => prev.filter((g) => g.id !== game.id));
    await supabase.from("games").delete().eq("id", game.id);
    lobbyChannelRef.current?.send({ type: "broadcast", event: "lobby-delete", payload: { gameId: game.id } });
  };

  const acceptInvite = async (game) => {
    if (!game || game.players?.includes(me) || game.players?.length !== 1) return;
    const { data } = await supabase.from("games").update({
      players: [...game.players, me],
      scores: { ...game.scores, [me]: 0 },
      phase: "ready",
      status: "Game accepted. Both players need to ready up to begin."
    }).eq("id", game.id).select().single();
    if (data) {
      lobbyChannelRef.current?.send({ type: "broadcast", event: "lobby-update", payload: { game: data } });
      setGameId(data.id);
    }
  };

  const pendingRequests = games.filter(
    (g) => g.players?.includes(me) && g.phase === "invited"
  );

  const incomingRequests = games.filter(
    (g) => g.phase === "invited" &&
      g.inviteEmail?.toLowerCase() === myEmail &&
      !g.players?.includes(me)
  );

  const activeGames = games.filter(
    (g) => g.players?.includes(me) && g.phase !== "invited" && g.phase !== "finished"
  );

  return (
    <div className="page-shell lobby-shell">

      {/* ── Send a Game Request ─────────────────────────────── */}
      <div className="panel lobby-panel">
        <h2>Send a Request</h2>

        <div className="field-row">
          <label htmlFor="opponentEmail">Opponent email</label>
          <input
            id="opponentEmail"
            type="email"
            value={opponentEmail}
            onChange={(e) => setOpponentEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createGame(); }}
            placeholder="friend@example.com"
          />
        </div>

        <div className="field-row">
          <label htmlFor="targetScore">Points needed to win</label>
          <input
            id="targetScore"
            type="number"
            min="3"
            max="10"
            value={targetScore}
            onChange={(e) => setTargetScore(e.target.value)}
          />
        </div>

        {error && <p className="notice">{error}</p>}

        <button className="button primary" onClick={createGame}>
          Send Request
        </button>

        {pendingRequests.length > 0 && (
          <div className="lobby-sublist">
            <h3>Pending Requests</h3>
            {pendingRequests.map((game) => (
              <div key={game.id} className="game-card">
                <div className="game-card-info">
                  <span><strong>To:</strong> {game.inviteEmail}</span>
                  <span><strong>Target score:</strong> {game.targetScore || DEFAULT_TARGET_SCORE}</span>
                  {game.created_at && <span className="game-card-date">{formatDate(game.created_at)}</span>}
                </div>
                <button className="button secondary" onClick={() => cancelInvite(game)}>
                  Cancel
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Incoming Game Requests ──────────────────────────── */}
      <div className="panel lobby-panel">
        <h2>Incoming Requests</h2>
        {incomingRequests.length === 0 ? (
          <p>No incoming requests right now.</p>
        ) : (
          incomingRequests.map((game) => (
            <div key={game.id} className="game-card">
              <div className="game-card-info">
                <span><strong>From:</strong> {opponentDisplay(game)}</span>
                <span><strong>Target score:</strong> {game.targetScore || DEFAULT_TARGET_SCORE}</span>
                {game.created_at && <span className="game-card-date">{formatDate(game.created_at)}</span>}
              </div>
              <button className="button primary" onClick={() => acceptInvite(game)}>
                Accept
              </button>
            </div>
          ))
        )}
      </div>

      {/* ── Active Games ────────────────────────────────────── */}
      <div className="panel lobby-panel">
        <h2>Active Games</h2>
        {activeGames.length === 0 ? (
          <p>No active games. Send a request or accept one to start playing.</p>
        ) : (
          activeGames.map((game) => {
            const myScore = game.scores?.[me] ?? 0;
            const opponentId = game.players?.find((id) => id !== me);
            const oppScore = game.scores?.[opponentId] ?? 0;
            return (
              <div key={game.id} className="game-card">
                <div className="game-card-info">
                  <span><strong>Opponent:</strong> {opponentDisplay(game)}</span>
                  <span><strong>Target score:</strong> {game.targetScore || DEFAULT_TARGET_SCORE}</span>
                  <span><strong>Score: </strong>{myScore} – {oppScore}</span>
                  {game.created_at && <span className="game-card-date">{formatDate(game.created_at)}</span>}
                </div>
                <button className="button secondary" onClick={() => setGameId(game.id)}>
                  Resume
                </button>
              </div>
            );
          })
        )}
      </div>

    </div>
  );
}
