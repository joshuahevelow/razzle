import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabaseClient";
import WordInput from "../components/WordInput";
import { WORDS } from "../data/dictionary";
import hourglass from "../assets/10s_challenge_hourglass.gif";
import hourglassStart from "../assets/10s_challenge_hourglass_start.png";

const MIN_LENGTH = 4;
const MAX_CARRIAGE = 3;

const COLUMN_DICE_SETS = [
  ["H", "L", "L", "R", "W", "N"],
  ["T", "F", "P", "T", "H", "C"],
  ["R", "L", "E", "K", "R", "I"],
  ["E", "A", "B", "M", "C", "S"],
  ["I", "O", "U", "I", "A", "A"],
  ["O", "G", "E", "P", "S", "D"]
];

function shuffleArray(array) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function rollDice() {
  const columns = shuffleArray([...Array(6).keys()]);
  return {
    dice: columns.map(dieIndex => {
      const die = COLUMN_DICE_SETS[dieIndex];
      return die[Math.floor(Math.random() * die.length)];
    })
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function validateWord(word, dice) {
  if (!word) return false;
  const text = word.trim().toUpperCase();
  if (text.length < MIN_LENGTH) return false;

  const counts = dice.reduce((acc, letter) => {
    acc[letter] = (acc[letter] || 0) + 1;
    return acc;
  }, {});

  for (const char of text) {
    if (!counts[char]) return false;
    counts[char] -= 1;
  }

  return true;
}

function pushDirection(game, playerId) {
  return game.players.indexOf(playerId) === 0 ? 1 : -1;
}

function normalizeWord(word) {
  return word.trim().toLowerCase().replace(/[^a-z]/g, "");
}

function isDictionaryWord(word) {
  return WORDS.has(normalizeWord(word).toUpperCase());
}

export default function Game({ gameId, user, onLeave }) {
  const [game, setGame] = useState(null);
  const [roundMessage, setRoundMessage] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [activeLetters, setActiveLetters] = useState(Array(6).fill(""));
  const [challengeGifPlaying, setChallengeGifPlaying] = useState(false);
  const [challengeGifKey, setChallengeGifKey] = useState(0);
  const previousPositionRef = useRef(0);
  const channelRef = useRef(null);

  useEffect(() => {
    let channel;

    const loadGame = async () => {
      const { data, error } = await supabase.from("games").select("*").eq("id", gameId).single();
      if (error) {
        console.error(error);
        return;
      }
      setGame(data);
    };

    loadGame();

    channel = supabase
      .channel(`game-${gameId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "games",
          filter: `id=eq.${gameId}`
        },
        (payload) => {
          if (payload.new) {
            setGame(payload.new);
          }
        }
      )
      .on("broadcast", { event: "game-update" }, ({ payload }) => {
        if (payload?.game) setGame(payload.game);
      })
      .subscribe();

    channelRef.current = channel;

    return () => {
      channelRef.current = null;
      if (channel) channel.unsubscribe();
    };
  }, [gameId]);

  useEffect(() => {
    if (!game?.challenge?.active) {
      setCountdown(0);
      return;
    }

    const interval = setInterval(() => {
      const left = Math.max(0, Math.ceil((game.challenge.expiresAt - Date.now()) / 1000));
      setCountdown(left);
    }, 250);

    return () => clearInterval(interval);
  }, [game?.challenge?.active, game?.challenge?.expiresAt]);

  useEffect(() => {
    if (!game?.dice?.length) return;
    setActiveLetters(game.dice.map(letter => letter.toUpperCase()));
  }, [game?.dice]);

  useEffect(() => {
    if (!game?.challenge?.active) {
      setChallengeGifPlaying(false);
      return;
    }
    // Start the gif on all clients (challenger via optimistic update, opponent via broadcast)
    setChallengeGifPlaying(true);
    setChallengeGifKey(prev => prev + 1);
  }, [game?.challenge?.active]);

  const handleChallengeClick = async () => {
    const result = await startChallenge();
    if (!result) {
      setChallengeGifPlaying(false);
    }
  };

  useEffect(() => {
    if (!game?.challenge?.active) return;
    // Only the challenger resolves the timeout — prevents both clients from
    // independently rolling dice and writing conflicting letters to the DB.
    if (game.challenge.challenger !== user.id) return;

    const resolveChallenge = async () => {
      const position = clamp(game.position + pushDirection(game, game.challenge.challenger), -MAX_CARRIAGE, MAX_CARRIAGE);
      const challengerIsLeft = game.players[0] === game.challenge.challenger;
      const scored = position === (challengerIsLeft ? MAX_CARRIAGE : -MAX_CARRIAGE);
      const newDice = rollDice();
      const update = {
        position: scored ? 0 : position,
        dice: newDice.dice,
        roundOpen: true,
        challenge: null,
        status: scored
          ? "Challenge time expired. Challenger scores the push and the carriage returns to the center."
          : "Challenge time expired. The challenger pushes a row ahead."
      };

      if (scored) {
        update.scores = {
          ...game.scores,
          [game.challenge.challenger]: (game.scores[game.challenge.challenger] || 0) + 1
        };
      }

      await updateGame(update);
      setChallengeGifPlaying(false);
    };

    const remaining = game.challenge.expiresAt - Date.now();
    if (remaining <= 0) {
      resolveChallenge();
      return;
    }

    const timeout = setTimeout(resolveChallenge, remaining);
    return () => clearTimeout(timeout);
  }, [game, game?.challenge, gameId]);

  if (!game) return <div className="page-shell"><div className="panel">Loading game...</div></div>;

  const me = user.id;
  const opponent = game.players.find(id => id !== me);
  const myScore = game.scores?.[me] ?? 0;
  const opponentScore = game.scores?.[opponent] ?? 0;
  const targetScore = game.targetScore || 5;
  const isPlaying = game.phase === "playing";
  const winner = game.players.find(id => (game.scores?.[id] || 0) >= targetScore);
  const roundOpen = Boolean(game.roundOpen) && !winner;
  const challengeActive = game.challenge?.active === true;
  const challengeChallenger = game.challenge?.challenger;
  const challengeOpponent = challengeActive && challengeChallenger !== me;
  const challengeInputDisabled = !roundOpen || !!winner || (challengeActive && challengeChallenger === me);
  const isViewerFirstPlayer = game.players[0] === me;
  const baseActiveRowIndex = clamp(3 - game.position, 0, 6);
  const activeRowIndex = isViewerFirstPlayer ? baseActiveRowIndex : 6 - baseActiveRowIndex;
  const scoreRows = Array.from({ length: targetScore }, (_, index) => targetScore - index);
  const mySliderIndex = Math.max(0, Math.min(targetScore - myScore - 1, targetScore - 1));
  const opponentSliderIndex = Math.max(0, Math.min(targetScore - opponentScore - 1, targetScore - 1));

  const formatPlayer = (id) => id === me ? "You" : "Opponent";
  const formatPosition = (pos) => {
    if (pos === 0) return "Center";
    return pos > 0 ? "Toward opponent" : "Toward you";
  };

  const updateGame = async (update) => {
    // Optimistic update: apply immediately so UI doesn't wait on network
    const optimisticGame = game ? { ...game, ...update } : null;
    setGame(optimisticGame);

    // Broadcast directly over WebSocket to all other clients (<50ms vs postgres_changes which can be 500ms+)
    channelRef.current?.send({
      type: "broadcast",
      event: "game-update",
      payload: { game: optimisticGame }
    });

    const { data, error } = await supabase.from("games").update(update).eq("id", gameId).select().single();
    if (error) {
      console.error("Failed to update game:", error);
      setRoundMessage(`Could not update the game: ${error.message}`);
      return null;
    }
    if (data) {
      setGame(data);
      return data;
    }
    // .select() returned null (e.g. RLS filtered the row) — refetch to sync canonical state
    const { data: refetched } = await supabase.from("games").select("*").eq("id", gameId).single();
    if (refetched) setGame(refetched);
    return refetched ?? null;
  };

  const startGame = async () => {
    const newDice = rollDice();
    await updateGame({
      phase: "playing",
      position: 0,
      dice: newDice.dice,
      roundOpen: true,
      challenge: null,
      status: "Round started. Search the six letters for a word of four letters or more."
    });
  };

  const submitWord = async (word) => {
    if (!roundOpen) {
      setRoundMessage("The round is not open. Wait for the next carriage move.");
      return;
    }

    if (!word.trim()) {
      setRoundMessage("Enter a word before submitting.");
      return;
    }

    if (challengeGifPlaying) {
      setChallengeGifPlaying(false);
    }

    const hasLetters = validateWord(word, game.dice);
    const dictionaryValid = hasLetters && isDictionaryWord(word);
    const valid = hasLetters && dictionaryValid;
    const direction = pushDirection(game, me);

    if (!hasLetters) {
      setRoundMessage("That word cannot be formed from the available letter cubes.");
    } else if (!dictionaryValid) {
      setRoundMessage("That word is not in the dictionary.");
    }

    if (challengeActive && challengeChallenger === me) {
      setRoundMessage("You started the challenge. Wait for your opponent to answer.");
      return;
    }

    if (challengeActive && challengeOpponent) {
      if (!valid) {
        const position = clamp(game.position - direction, -MAX_CARRIAGE, MAX_CARRIAGE);
        const scored = position === (me === game.players[0] ? -MAX_CARRIAGE : MAX_CARRIAGE);
        const newDice = rollDice();
        const update = {
          position: scored ? 0 : position,
          dice: newDice.dice,
          roundOpen: true,
          challenge: null,
          status: scored
            ? `Incorrect during challenge. Challenger scores a point.`
            : `Incorrect during challenge. Challenger pushes the carriage one row ahead.`
        };

        if (scored) {
          update.scores = {
            ...game.scores,
            [challengeChallenger]: (game.scores[challengeChallenger] || 0) + 1
          };
        }

        await updateGame(update);
        setRoundMessage("");
        return;
      }

      const position = clamp(game.position + direction, -MAX_CARRIAGE, MAX_CARRIAGE);
      const scored = position === (me === game.players[0] ? MAX_CARRIAGE : -MAX_CARRIAGE);
      const newDice = rollDice();
      const update = {
        position: scored ? 0 : position,
        dice: newDice.dice,
        roundOpen: true,
        challenge: null,
        status: scored
          ? `Challenge won! ${formatPlayer(me)} spells a valid word and scores the point.`
          : `Challenge won. ${formatPlayer(me)} pushes the carriage one row ahead.`
      };

      if (scored) {
        update.scores = {
          ...game.scores,
          [me]: myScore + 1
        };
      }

      await updateGame(update);
      setRoundMessage("");
      return;
    }

    if (valid) {
      const position = clamp(game.position + direction, -MAX_CARRIAGE, MAX_CARRIAGE);
      const scored = position === (me === game.players[0] ? MAX_CARRIAGE : -MAX_CARRIAGE);
      const newDice = rollDice();
      const update = {
        position: scored ? 0 : position,
        dice: newDice.dice,
        roundOpen: true,
        status: scored
          ? `${formatPlayer(me)} spelled a valid word and scored a point! The carriage returns to the center.`
          : `${formatPlayer(me)} spelled a valid word. The carriage moves one row toward the opponent.`
      };

      if (scored) {
        update.scores = {
          ...game.scores,
          [me]: myScore + 1
        };
      }

      await updateGame(update);
      setRoundMessage("");
      return;
    }

    const position = clamp(game.position - direction, -MAX_CARRIAGE, MAX_CARRIAGE);
    const scored = position === (me === game.players[0] ? -MAX_CARRIAGE : MAX_CARRIAGE);
    const newDice = rollDice();
    const update = {
      position: scored ? 0 : position,
      dice: newDice.dice,
      roundOpen: true,
      status: scored
        ? `Incorrect word. Opponent pushes the carriage against the wall and scores a point.`
        : `Incorrect word. Opponent pushes the carriage one row ahead.`
    };

    if (scored) {
      update.scores = {
        ...game.scores,
        [opponent]: (game.scores[opponent] || 0) + 1
      };
    }

    await updateGame(update);
    setRoundMessage("");
  };

  const startChallenge = async () => {
    if (!roundOpen || challengeActive) return null;

    return updateGame({
      challenge: {
        active: true,
        challenger: me,
        expiresAt: Date.now() + 10000
      },
      status: `${formatPlayer(me)} has challenged the opponent. The opponent has 10 seconds to spell a word.`
    });
  };

  const leaveGame = async () => {
    const remainingPlayers = (game.players || []).filter(id => id !== me);
    const remainingScores = Object.fromEntries(
      Object.entries(game.scores || {}).filter(([key]) => key !== me)
    );

    if (remainingPlayers.length === 0) {
      await supabase.from("games").delete().eq("id", gameId);
    } else {
      await supabase.from("games").update({
        players: remainingPlayers,
        scores: remainingScores,
        phase: "waiting",
        roundOpen: false,
        challenge: null,
        status: `${formatPlayer(me)} has left the game. Waiting for a new opponent.`
      }).eq("id", gameId);
    }

    onLeave?.();
  };

  return (
    <div className="page-shell">
      <div className="panel game-panel">
        <div className="game-header">
          <div>
            <h1>Razzle</h1>
          </div>
            {game.phase === "ready" ? (
                <button className="button secondary start-button" onClick={startGame}>
                  Start Game
                </button>
            ) :
            <button className="button secondary leave-button" onClick={leaveGame}>
            Leave Game
            </button>
            }
        </div>

        <div className="status-box">
          <p>{game.status}</p>
          {roundMessage && <p className="notice">{roundMessage}</p>}
          {challengeActive && <p className="notice">Challenge countdown: {countdown}s</p>}
        </div>

        <div className="board-layout">
          <div className="left-sidebar">
            <div className="score-column right-score">
              <div className="score-label">Opponent</div>
              {scoreRows.slice().reverse().map((rowValue, idx) => {
                const actualRow = scoreRows.length - 1 - idx;
                const filled = opponentScore >= scoreRows[actualRow];
                const slider = actualRow === opponentSliderIndex;
                return (
                  <div key={rowValue} className={`score-row ${filled ? "filled" : ""} ${slider ? "slider" : ""}`}>
                    {rowValue}
                  </div>
                );
              })}
            </div>

            <div className="challenge-column">
              <button className="button challenge-button circular" onClick={handleChallengeClick} disabled={!isPlaying || challengeActive}>
                {challengeGifPlaying ? (
                  <img
                    key={challengeGifKey}
                    className="challenge-gif"
                    src={`${hourglass}?v=${challengeGifKey}`}
                    alt="challenge animation"
                  />
                ) : (
                  <img className="challenge-static" src={hourglassStart}></img>
                )}
              </button>
            </div>

            <div className="score-column left-score">
              {scoreRows.map((rowValue, idx) => {
                const filled = myScore >= rowValue;
                const slider = idx === mySliderIndex;
                return (
                  <div key={rowValue} className={`score-row ${filled ? "filled" : ""} ${slider ? "slider" : ""}`}>
                    {rowValue}
                  </div>
                );
              })}
              <div className="score-label">You</div>
            </div>
          </div>

          <div className="board-column">
            <div className="board-grid">
              {Array.from({ length: 7 }).map((_, row) => (
                <div key={row} className={`grid-row ${activeRowIndex === row ? "active" : ""}`}>
                  {Array.from({ length: 6 }).map((__, col) => (
                    <div key={col} className="grid-cell">
                      {activeRowIndex === row ? activeLetters[col] : ""}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        {winner ? (
          <div className="endgame-panel">
            <h2>{formatPlayer(winner)} wins the game!</h2>
            <p>Start a new match from the lobby when ready.</p>
          </div>
        ) : null}

        <div className="controls-panel bottom-controls">
          <WordInput onSubmit={submitWord} disabled={challengeInputDisabled} />
        </div>
      </div>
    </div>
  );
}
