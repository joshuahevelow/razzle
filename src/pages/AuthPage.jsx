import { useState } from "react";
import { supabase } from "../supabaseClient";

export default function AuthPage() {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [signedUp, setSignedUp] = useState(false);

  const handleSignUp = async () => {
    setError("");
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      setError(error.message);
    } else if (data.user?.identities?.length === 0) {
      // Supabase returns a fake success when the email is already registered
      setError("An account with that email already exists. Try logging in instead.");
    } else {
      setSignedUp(true);
    }
  };

  const handleLogin = async () => {
    setError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
  };

  const switchMode = (newMode) => {
    setMode(newMode);
    setError("");
    setSignedUp(false);
  };

  return (
    <div className="page-shell auth-shell">
      <h1>Razzle</h1>
      <div className="panel auth-panel">
        {signedUp ? (
          <>
            <h2>Check your email</h2>
            <p>
              We sent a confirmation link to <strong>{email}</strong>. Click it
              to activate your account, then come back to log in.
            </p>
            <button className="button secondary" onClick={() => switchMode("login")}>
              Back to Log In
            </button>
          </>
        ) : (
          <>
            <h2>{mode === "login" ? "Log In" : "Sign Up"}</h2>

            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>

            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") mode === "login" ? handleLogin() : handleSignUp(); }}
                placeholder={mode === "login" ? "Your password" : "Choose a password"}
              />
            </label>

            {error && <p className="notice">{error}</p>}

            <button
              className="button primary"
              onClick={mode === "login" ? handleLogin : handleSignUp}
            >
              {mode === "login" ? "Log In" : "Sign Up"}
            </button>

            <p className="auth-switch">
              {mode === "login" ? (
                <>
                  Don&apos;t have an account?{" "}
                  <button className="link-button" onClick={() => switchMode("signup")}>Sign up</button>
                </>
              ) : (
                <>
                  Already have an account?{" "}
                  <button className="link-button" onClick={() => switchMode("login")}>Log in</button>
                </>
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
