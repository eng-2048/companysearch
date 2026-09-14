"use client";

import { useState } from "react";

export default function Login() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setErr("Wrong password.");
        setBusy(false);
        return;
      }
      const next = new URLSearchParams(window.location.search).get("next") || "/";
      window.location.href = next.startsWith("/") ? next : "/";
    } catch {
      setErr("Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/2048-logo.jpg" alt="2048 Ventures" />
        </div>
        <h1>Company Search</h1>
        <p>Enter the password to continue.</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
        />
        <button type="submit" disabled={busy || !password}>
          {busy ? "Checking…" : "Enter"}
        </button>
        {err && <div className="login-err">{err}</div>}
      </form>
    </div>
  );
}
