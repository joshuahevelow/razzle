import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabaseClient";
import WordInput from "../components/WordInput";
import { WORDS } from "../data/dictionary";
import hourglass from "../assets/10s_challenge_hourglass.gif";
import hourglassStart from "../assets/10s_challenge_hourglass_start.png";

const MIN_LENGTH = 4;
const MAX_CARRIAGE = 4;
const CHALLENGE_DURATION_MS = 10000;

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

function rollAllDice() {
  const assignments = shuffleArray([...Array(6).keys()]);
  return {
    diceAssignments: assignments,
    dice: assignments.map(dieIndex => {
      const die = COLUMN_DICE_SETS[dieIndex];
      return die[Math.floor(Math.random() * die.length)];
    })
  };
}

function rollFaces(assignments) {
  const cols = (assignments && assignments.length === 6)
    ? assignments
    : shuffleArray([...Array(6).keys()]);
  return {
    dice: cols.map(dieIndex => {
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

function renderStatus(line) {
  const parts = line.split(/\*\*(.*?)\*\*/g);
  return parts.map((part, i) => i % 2 === 1 ? <strong key={i}>{part}</strong> : part);
}

export default function Game({ gameId, user, onLeave }) {
  const [game, setGame] = useState(null);
  const [roundMessage, setRoundMessage] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [activeLetters, setActiveLetters] = useState(Array(6).fill(""));
  const [challengeGifPlaying, setChallengeGifPlaying] = useState(false);
  const [challengeGifKey, setChallengeGifKey] = useState(0);
  const [playedWords, setPlayedWords] = useState([]);
  const [readyCountdown, setReadyCountdown] = useState(null);
  const [playerProfiles, setPlayerProfiles] = useState({});
  const [flashWord, setFlashWord] = useState(null);
  const [isDiceShuffling, setIsDiceShuffling] = useState(false);
  const diceResetKeyRef = useRef(0);
  const previousPositionRef = useRef(0);
  const channelRef = useRef(null);
  const shuffleRef = useRef(null);
  const gridRef = useRef(null);
  const carriageRef = useRef(null);
  const isFirstCarriage = useRef(true);
  const longShuffleRef = useRef(false);
  const prevScoresSumRef = useRef(0);
  const challengeLocalStartRef = useRef(null);

  useEffect(() => {
    let channel;

    const loadGame = async () => {
      const { data, error } = await supabase.from("games").select("*").eq("id", gameId).single();
      if (error) {
        console.error(error);
        return;
      }
      setGame(data);
      setPlayedWords(data.playedWords || []);
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
            setPlayedWords(payload.new.playedWords || []);
          }
        }
      )
      .on("broadcast", { event: "game-update" }, ({ payload }) => {
        if (payload?.game) setGame(payload.game);
      })
      .on("broadcast", { event: "word-played" }, ({ payload }) => {
        if (!payload?.word) return;
        setFlashWord({ word: payload.word, valid: payload.valid, key: Date.now() });
        setPlayedWords(prev => {
          if (prev.some(w => w.id === payload.id)) return prev;
          return [...prev, payload];
        });
      })
      .subscribe();

    channelRef.current = channel;

    return () => {
      channelRef.current = null;
      if (channel) channel.unsubscribe();
    };
  }, [gameId]);

  // Track presence: add ourselves to presentPlayers on mount, remove on unmount
  useEffect(() => {
    if (!user?.id || !gameId) return;
    const userId = user.id;

    const join = async () => {
      // Fetch the full row so we can broadcast the complete updated game to others
      const { data } = await supabase.from("games").select("*").eq("id", gameId).single();
      if (!data) return;
      const current = data.presentPlayers || [];
      if (current.includes(userId)) return;
      const newPresent = [...current, userId];
      const { data: updated } = await supabase
        .from("games")
        .update({ presentPlayers: newPresent })
        .eq("id", gameId)
        .select()
        .single();
      if (updated) {
        // Update our own local state and broadcast to the other player immediately
        setGame(updated);
        channelRef.current?.send({
          type: "broadcast",
          event: "game-update",
          payload: { game: updated }
        });
      }
    };

    const leave = async () => {
      const { data } = await supabase.from("games").select("presentPlayers").eq("id", gameId).single();
      const current = data?.presentPlayers || [];
      await supabase.from("games").update({ presentPlayers: current.filter(id => id !== userId) }).eq("id", gameId);
    };

    join();
    return () => { leave(); };
  }, [gameId, user?.id]);

  useEffect(() => {
    if (!game?.readyPlayers || !game?.players) return;
    const bothReady = game.players.length >= 2 && game.players.every(id => (game.readyPlayers || []).includes(id));
    if (bothReady && game.phase !== "playing") {
      setReadyCountdown(3);
    }
  }, [JSON.stringify(game?.readyPlayers)]);

  useEffect(() => {
    if (game?.phase === "paused" || game?.phase === "ready") {
      setReadyCountdown(null);
    }
  }, [game?.phase]);

  useEffect(() => {
    if (readyCountdown === null) return;
    if (readyCountdown > 0) {
      const t = setTimeout(() => setReadyCountdown(c => c - 1), 1000);
      return () => clearTimeout(t);
    }
    // countdown reached 0 — only players[0] fires the actual game start/resume
    if (game?.players?.[0] !== me) return;
    const isResume = (game.dice?.length > 0);
    const newDice = rollAllDice();
    updateGame({
      readyPlayers: game.readyPlayers,
      phase: "playing",
      ...(isResume ? {} : { position: 0 }),
      dice: newDice.dice,
      diceAssignments: newDice.diceAssignments,
      roundOpen: true,
      challenge: null,
      status: "Round started. Search the six letters for a word of four letters or more."
    });
    setReadyCountdown(null);
  }, [readyCountdown]);

  useEffect(() => {
    if (!game?.challenge?.active) {
      setCountdown(0);
      challengeLocalStartRef.current = null;
      return;
    }
    // Record when *this client* first sees the challenge go active so the
    // countdown is driven by local wall-clock time, not the challenger's
    // absolute timestamp (which can differ between devices by many seconds).
    if (!challengeLocalStartRef.current) {
      challengeLocalStartRef.current = Date.now();
    }
    const localStart = challengeLocalStartRef.current;
    const interval = setInterval(() => {
      setCountdown(Math.max(0, Math.ceil((CHALLENGE_DURATION_MS - (Date.now() - localStart)) / 1000)));
    }, 250);
    return () => clearInterval(interval);
  }, [game?.challenge?.active]);

  // Detect score increases so the dice shuffle can run longer on both clients.
  useEffect(() => {
    const sum = Object.values(game?.scores || {}).reduce((a, b) => a + b, 0);
    if (sum > prevScoresSumRef.current) longShuffleRef.current = true;
    prevScoresSumRef.current = sum;
  }, [JSON.stringify(game?.scores)]);

  useEffect(() => {
    if (!game?.dice?.length) return;
    const finalLetters = game.dice.map(l => l.toUpperCase());
    if (shuffleRef.current) { clearInterval(shuffleRef.current); shuffleRef.current = null; }
    const ALL = 'ABCDEFGHIJKLMNOPRSTW'.split('');
    const rand = () => ALL[Math.floor(Math.random() * ALL.length)];
    let ticks = 0;
    const isLong = longShuffleRef.current;
    longShuffleRef.current = false;
    const TICKS = isLong ? 22 : 8;
    const INTERVAL = isLong ? 80 : 60;
    diceResetKeyRef.current += 1;
    setIsDiceShuffling(true);
    setActiveLetters(finalLetters.map(rand));
    shuffleRef.current = setInterval(() => {
      ticks++;
      if (ticks >= TICKS) {
        clearInterval(shuffleRef.current);
        shuffleRef.current = null;
        setActiveLetters(finalLetters);
        setIsDiceShuffling(false);
      } else {
        setActiveLetters(finalLetters.map(() => rand()));
      }
    }, INTERVAL);
    return () => {
      if (shuffleRef.current) { clearInterval(shuffleRef.current); shuffleRef.current = null; }
      setIsDiceShuffling(false);
    };
  }, [JSON.stringify(game?.dice)]);

  useEffect(() => {
    if (!game?.players || !gridRef.current || !carriageRef.current) return;
    const isFirstPlayer = game.players[0] === user.id;
    const base = Math.min(Math.max(3 - (game.position || 0), 0), 6);
    const rowIndex = isFirstPlayer ? base : 6 - base;
    const rows = gridRef.current.querySelectorAll(':scope > .grid-row');
    const row = rows[rowIndex];
    if (!row) return;
    if (isFirstCarriage.current) {
      carriageRef.current.style.transition = 'none';
      carriageRef.current.style.top = row.offsetTop + 'px';
      carriageRef.current.style.height = row.offsetHeight + 'px';
      carriageRef.current.getBoundingClientRect(); // force reflow
      carriageRef.current.style.transition = '';
      isFirstCarriage.current = false;
    } else {
      carriageRef.current.style.top = row.offsetTop + 'px';
      carriageRef.current.style.height = row.offsetHeight + 'px';
    }
  }, [game?.position, game?.players]);

  useEffect(() => {
    if (!game?.players?.length) return;
    supabase.from("profiles").select("id, username").in("id", game.players).then(({ data }) => {
      if (data) setPlayerProfiles(Object.fromEntries(data.map(p => [p.id, p.username])));
    });
  }, [JSON.stringify(game?.players)]);

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
      const newDice = scored ? rollAllDice() : rollFaces(game.diceAssignments);
      const update = {
        position: scored ? 0 : position,
        dice: newDice.dice,
        diceAssignments: newDice.diceAssignments ?? game.diceAssignments,
        roundOpen: true,
        challenge: null,
        status: scored
          ? `Challenge successful: ${formatPlayer(game.challenge.challenger)} advances.\n${formatPlayer(game.challenge.challenger)} scores a point!`
          : `Challenge successful: ${formatPlayer(game.challenge.challenger)} advances.`
      };

      if (scored) {
        update.scores = {
          ...game.scores,
          [game.challenge.challenger]: (game.scores[game.challenge.challenger] || 0) + 1
        };
        if ((game.scores[game.challenge.challenger] || 0) + 1 >= (game.targetScore || 5)) update.phase = "finished";
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
  }, [game?.challenge?.active, game?.challenge?.expiresAt, gameId]);

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
  const challengeInputDisabled = !roundOpen || !!winner || (challengeActive && challengeChallenger === me) || isDiceShuffling;
  const isViewerFirstPlayer = game.players[0] === me;
  const baseActiveRowIndex = clamp(3 - game.position, 0, 6);
  const activeRowIndex = isViewerFirstPlayer ? baseActiveRowIndex : 6 - baseActiveRowIndex;
  const scoreRows = Array.from({ length: targetScore + 1 }, (_, index) => targetScore - index);
  const mySliderIndex = Math.max(0, Math.min(targetScore - myScore, targetScore));
  const opponentSliderIndex = Math.max(0, Math.min(targetScore - opponentScore, targetScore));

  const formatPlayer = (id) => {
    if (playerProfiles[id]) return playerProfiles[id];
    if (id === game.players[0]) return game.senderEmail || "Player 1";
    if (id === game.players[1]) return game.inviteEmail || "Player 2";
    return "Player";
  };
  const formatPosition = (pos) => {
    if (pos === 0) return "Center";
    return pos > 0 ? "Toward opponent" : "Toward you";
  };

  const updateGame = async (update) => {
    // Optimistic update: apply immediately so UI doesn't wait on network
    const optimisticGame = game ? { ...game, ...update } : null;
    setGame(optimisticGame);

    // Capture the position BEFORE the optimistic update for the concurrency lock below.
    // This is safe because game (closure value) hasn't changed — setGame is async.
    const expectedPosition = 'position' in update ? game.position : undefined;

    // Broadcast directly over WebSocket to all other clients (<50ms vs postgres_changes which can be 500ms+)
    // Always include ourselves in presentPlayers of the broadcast so the recipient knows we're here,
    // unless we're explicitly passing presentPlayers in the update (e.g. leaveGame removes us).
    const broadcastGame = update.presentPlayers !== undefined
      ? optimisticGame
      : { ...optimisticGame, presentPlayers: [...new Set([...(optimisticGame?.presentPlayers || []), me])] };
    channelRef.current?.send({
      type: "broadcast",
      event: "game-update",
      payload: { game: broadcastGame }
    });

    // diceAssignments is maintained in local/broadcast state but not yet in the DB schema.
    // Strip it from the Supabase write to avoid a column-not-found error that would silently
    // prevent scores and phase updates from being persisted.
    const { diceAssignments: _da, ...dbUpdate } = update;

    // When the update moves the carriage, add an optimistic-lock condition so that
    // two simultaneous word submissions don't silently overwrite each other.
    // .maybeSingle() returns { data: null, error: null } when 0 rows matched (lock lost).
    let query = supabase.from("games").update(dbUpdate).eq("id", gameId);
    if (expectedPosition !== undefined) query = query.eq("position", expectedPosition);
    const { data, error } = await query.select().maybeSingle();

    if (error) {
      console.error("Failed to update game:", error);
      setRoundMessage(`Could not update the game: ${error.message}`);
      return null;
    }
    if (data) {
      // Apply only the fields we sent to the DB, so a partial update (e.g. challenge-only)
      // doesn't overwrite fields like dice/position that a concurrent word-submission
      // update has already set locally but hasn't committed to the DB yet.
      setGame(prev => prev
        ? { ...prev, ...Object.fromEntries(Object.keys(dbUpdate).map(k => [k, data[k]])) }
        : data);
      return data;
    }

    // 0 rows matched — either optimistic lock lost (concurrent submission) or RLS filtered.
    // Re-fetch canonical state and broadcast the correction to undo our false optimistic update.
    const { data: refetched } = await supabase.from("games").select("*").eq("id", gameId).single();
    if (refetched) {
      setGame(refetched);
      channelRef.current?.send({ type: "broadcast", event: "game-update", payload: { game: refetched } });
    }
    if (expectedPosition !== undefined) {
      setRoundMessage("Your opponent submitted at the same time — wait for the new letters, then try again.");
    }
    return null;
  };

  const readyUp = async () => {
    const alreadyReady = (game.readyPlayers || []);
    if (alreadyReady.includes(me)) return;
    const newReadyPlayers = [...alreadyReady, me];
    const bothReady = newReadyPlayers.length === 2 && game.players.every(id => newReadyPlayers.includes(id));

    if (bothReady) {
      await updateGame({
        readyPlayers: newReadyPlayers,
        status: "Both players are ready! Starting in 3 seconds..."
      });
    } else {
      await updateGame({
        readyPlayers: newReadyPlayers,
        status: "One player is ready. Waiting for the other to ready up..."
      });
    }
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
    const wordUpper = word.trim().toUpperCase();
    const invalidReason = wordUpper.length < MIN_LENGTH
      ? "too few letters"
      : !hasLetters
      ? "used letters not on the board"
      : "word not found in dictionary";

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
        const newDice = scored ? rollAllDice() : rollFaces(game.diceAssignments);
        const update = {
          position: scored ? 0 : position,
          dice: newDice.dice,
          diceAssignments: newDice.diceAssignments ?? game.diceAssignments,
          roundOpen: true,
          challenge: null,
          status: scored
            ? `${formatPlayer(me)} entered an invalid word: **${wordUpper}** (${invalidReason})\n${formatPlayer(challengeChallenger)} scores a point!`
            : `${formatPlayer(me)} entered an invalid word: **${wordUpper}** (${invalidReason})`
        };

        if (scored) {
          update.scores = {
            ...game.scores,
            [challengeChallenger]: (game.scores[challengeChallenger] || 0) + 1
          };
          if ((game.scores[challengeChallenger] || 0) + 1 >= targetScore) update.phase = "finished";
        }

        const wid1 = `${Date.now()}-${wordUpper}`;
        update.playedWords = [...(game.playedWords || []), { id: wid1, word: wordUpper, email: formatPlayer(me), valid: false }];
        await updateGame(update);
        setPlayedWords(prev => prev.some(w => w.id === wid1) ? prev : [...prev, { id: wid1, word: wordUpper, email: formatPlayer(me), valid: false }]);
        channelRef.current?.send({ type: "broadcast", event: "word-played", payload: { id: wid1, word: wordUpper, email: formatPlayer(me), valid: false } });
        setRoundMessage("");
        return;
      }

      const position = clamp(game.position + direction, -MAX_CARRIAGE, MAX_CARRIAGE);
      const scored = position === (me === game.players[0] ? MAX_CARRIAGE : -MAX_CARRIAGE);
      const newDice = scored ? rollAllDice() : rollFaces(game.diceAssignments);
      const update = {
        position: scored ? 0 : position,
        dice: newDice.dice,
        diceAssignments: newDice.diceAssignments ?? game.diceAssignments,
        roundOpen: true,
        challenge: null,
        status: scored
          ? `${formatPlayer(me)} entered a valid word: **${wordUpper}**\n${formatPlayer(me)} scores a point!`
          : `${formatPlayer(me)} entered a valid word: **${wordUpper}**`
      };

      if (scored) {
        update.scores = {
          ...game.scores,
          [me]: myScore + 1
        };
        if (myScore + 1 >= targetScore) update.phase = "finished";
      }

      const wid2 = `${Date.now()}-${wordUpper}`;
      update.playedWords = [...(game.playedWords || []), { id: wid2, word: wordUpper, email: formatPlayer(me), valid: true }];
      await updateGame(update);      setFlashWord({ word: wordUpper, valid: false, key: Date.now() });      setFlashWord({ word: wordUpper, valid: true, key: Date.now() });
      setPlayedWords(prev => prev.some(w => w.id === wid2) ? prev : [...prev, { id: wid2, word: wordUpper, email: formatPlayer(me), valid: true }]);
      channelRef.current?.send({ type: "broadcast", event: "word-played", payload: { id: wid2, word: wordUpper, email: formatPlayer(me), valid: true } });
      setRoundMessage("");
      return;
    }

    if (valid) {
      const position = clamp(game.position + direction, -MAX_CARRIAGE, MAX_CARRIAGE);
      const scored = position === (me === game.players[0] ? MAX_CARRIAGE : -MAX_CARRIAGE);
      const newDice = scored ? rollAllDice() : rollFaces(game.diceAssignments);
      const update = {
        position: scored ? 0 : position,
        dice: newDice.dice,
        diceAssignments: newDice.diceAssignments ?? game.diceAssignments,
        roundOpen: true,
        status: scored
          ? `${formatPlayer(me)} entered a valid word: **${wordUpper}**\n${formatPlayer(me)} scores a point!`
          : `${formatPlayer(me)} entered a valid word: **${wordUpper}**`
      };

      if (scored) {
        update.scores = {
          ...game.scores,
          [me]: myScore + 1
        };
        if (myScore + 1 >= targetScore) update.phase = "finished";
      }

      const wid3 = `${Date.now()}-${wordUpper}`;
      update.playedWords = [...(game.playedWords || []), { id: wid3, word: wordUpper, email: formatPlayer(me), valid: true }];
      await updateGame(update);
      setFlashWord({ word: wordUpper, valid: true, key: Date.now() });
      setPlayedWords(prev => prev.some(w => w.id === wid3) ? prev : [...prev, { id: wid3, word: wordUpper, email: formatPlayer(me), valid: true }]);
      channelRef.current?.send({ type: "broadcast", event: "word-played", payload: { id: wid3, word: wordUpper, email: formatPlayer(me), valid: true } });
      setRoundMessage("");
      return;
    }

    const position = clamp(game.position - direction, -MAX_CARRIAGE, MAX_CARRIAGE);
    const scored = position === (me === game.players[0] ? -MAX_CARRIAGE : MAX_CARRIAGE);
    const newDice = scored ? rollAllDice() : rollFaces(game.diceAssignments);
    const update = {
      position: scored ? 0 : position,
      dice: newDice.dice,
      diceAssignments: newDice.diceAssignments ?? game.diceAssignments,
      roundOpen: true,
      status: scored
        ? `${formatPlayer(me)} entered an invalid word: **${wordUpper}** (${invalidReason})\n${formatPlayer(opponent)} scores a point!`
        : `${formatPlayer(me)} entered an invalid word: **${wordUpper}** (${invalidReason})`
    };

    if (scored) {
      update.scores = {
        ...game.scores,
        [opponent]: (game.scores[opponent] || 0) + 1
      };
      if ((game.scores[opponent] || 0) + 1 >= targetScore) update.phase = "finished";
    }

    const wid4 = `${Date.now()}-${wordUpper}`;
    update.playedWords = [...(game.playedWords || []), { id: wid4, word: wordUpper, email: formatPlayer(me), valid: false }];
    await updateGame(update);
    setFlashWord({ word: wordUpper, valid: false, key: Date.now() });
    setPlayedWords(prev => prev.some(w => w.id === wid4) ? prev : [...prev, { id: wid4, word: wordUpper, email: formatPlayer(me), valid: false }]);
    channelRef.current?.send({ type: "broadcast", event: "word-played", payload: { id: wid4, word: wordUpper, email: formatPlayer(me), valid: false } });
    setRoundMessage("");
  };

  const startChallenge = async () => {
    if (!roundOpen || challengeActive) return null;

    return updateGame({
      challenge: {
        active: true,
        challenger: me,
        expiresAt: Date.now() + CHALLENGE_DURATION_MS
      },
      status: `${formatPlayer(me)} started a challenge: 10s`
    });
  };

  const pauseGame = async () => {
    await updateGame({
      phase: "paused",
      readyPlayers: [],
      roundOpen: false,
      challenge: null,
      status: "Game paused. Both players need to ready up to resume."
    });
    setReadyCountdown(null);
  };

  const leaveGame = async () => {
    const isAlone = (game.players || []).length <= 1;

    // Remove ourselves from presence immediately
    const presentNow = (game.presentPlayers || []).filter(id => id !== me);

    // Check winner by scores rather than local phase to avoid race where
    // game.phase hasn't caught up yet and we'd overwrite "finished" with "paused".
    const hasWinner = game.players?.some(id => (game.scores?.[id] ?? 0) >= (game.targetScore || 5));

    if (isAlone) {
      await supabase.from("games").delete().eq("id", gameId);
    } else if (game.phase !== "finished" && !hasWinner) {
      await updateGame({
        phase: "paused",
        readyPlayers: [],
        presentPlayers: presentNow,
        roundOpen: false,
        challenge: null,
        status: "A player stepped away. Both players need to ready up to resume."
      });
    }

    onLeave?.();
  };

  return (
    <div className="game-shell">

      {flashWord && (
        <div
          key={flashWord.key}
          className={`word-flash-overlay${flashWord.valid ? "" : " invalid"}`}
          onAnimationEnd={() => setFlashWord(null)}
        >
          {flashWord.word}
        </div>
      )}

      {/* ── Left sidebar: brand + status ─────────────── */}
      <div className="game-sidebar-left">
        <div className="game-brand-block">
          <div className="brand">Razzle</div>
          <div className="game-username">{playerProfiles[user?.id]}</div>
        </div>
        <div className="game-status-sidebar">
          <div className="status-box">
            {(game.status || "").split('\n').map((line, i, arr) => {
              const displayLine = (challengeActive && i === arr.length - 1)
                ? line.replace(/\d+s$/, `**${countdown}s**`)
                : line;
              return <p key={i}>{renderStatus(displayLine)}</p>;
            })}
            {/**roundMessage && <p className="notice">{roundMessage}</p>*/}
          </div>
        </div>
      </div>

      {/* ── Center: game panel ────────────────────────── */}
      <div className="game-panel">

        {/* Pre-game overlay */}
        {game.phase !== "playing" && !winner && (() => {
          const presentPlayers = [...new Set([...(game.presentPlayers || []), me])];
          const bothPresent = game.players.length >= 2 && game.players.every(id => presentPlayers.includes(id));
          const iReady = (game.readyPlayers || []).includes(me);

          return (
            <div className="game-overlay">
              <div className="game-overlay-card">
                {!bothPresent ? (
                  <p className="overlay-title">Waiting for opponent&hellip;</p>
                ) : readyCountdown !== null ? (
                  <p className="overlay-title">Game starting in {readyCountdown}&hellip;</p>
                ) : iReady ? (
                  <p className="overlay-title">Waiting for opponent to be ready&hellip;</p>
                ) : (
                  <>
                    <p className="overlay-title">{game.phase === "paused" ? "Game paused" : "Both players are here!"}</p>
                    <button className="button primary" onClick={readyUp}>Ready Up</button>
                  </>
                )}
              </div>
            </div>
          );
        })()}

        <div className="board-layout">
          <div className="left-sidebar">
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

            <div className="scores-pair">
              <div className="score-column right-score">
                <div className="score-label">Opp</div>
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

              <div className="score-column left-score">
                <div className="score-label">You</div>
                {scoreRows.map((rowValue, idx) => {
                  const filled = myScore >= rowValue;
                  const slider = idx === mySliderIndex;
                  return (
                    <div key={rowValue} className={`score-row ${filled ? "filled" : ""} ${slider ? "slider" : ""}`}>
                      {rowValue}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="board-column">
            <div className="board-grid" ref={gridRef}>
              <div className="carriage-bar" ref={carriageRef} />
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
          <WordInput onSubmit={submitWord} disabled={challengeInputDisabled} resetKey={diceResetKeyRef.current} />
        </div>
      </div>

      {/* ── Right sidebar: actions ────────────────────── */}
      <div className="game-sidebar-right">
        <button className="button secondary" onClick={leaveGame}>Leave Game</button>
        <div className="played-words-list">
          <div className="played-words-title">Words Played</div>
          <div className="played-words-scroll">
            {playedWords.length === 0
              ? <p className="played-words-empty">None yet</p>
              : <ul>
                  {playedWords.slice().reverse().map(entry => (
                    <li key={entry.id} className={`word-entry ${entry.valid ? "valid" : "invalid"}`}>
                      <strong>{entry.word}</strong>
                      <span className="word-entry-email">{entry.email}</span>
                    </li>
                  ))}
                </ul>
            }
          </div>
        </div>
        {isPlaying && (
          <button className="button secondary pause-game-button" onClick={pauseGame}>Pause Game</button>
        )}
      </div>

    </div>
  );
}
