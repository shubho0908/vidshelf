import { useEffect, useRef, useState } from "react";
import { unlockMedia } from "../lib/medialock";

// Full-page media lock - not a dialog. Renders INSTEAD of the app until the
// worker accepts the PIN and hands back a media token.
// TV/remote: the input and button are data-focusable so the spatial focus
// system (D-pad) can reach them; OK/Enter on the field opens the TV's
// on-screen keyboard, digits auto-submit at 6.
export default function LockView({ onUnlock }: { onUnlock: () => void }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-focus only where a physical keyboard exists (desktop/laptop).
    // On TVs this would fight the D-pad flow - there the remote's OK key
    // focuses the field and opens the on-screen keyboard instead.
    if (window.matchMedia("(pointer: fine) and (hover: hover)").matches) {
      inputRef.current?.focus();
    }
  }, []);

  async function submit(value: string) {
    if (busy || !/^\d{4,8}$/.test(value)) return;
    setBusy(true);
    setErr("");
    const r = await unlockMedia(value);
    setBusy(false);
    if (r === "ok") return onUnlock();
    setPin("");
    setErr(
      r === "wrong" ? "Wrong PIN. Try again."
      : r === "locked" ? "Too many wrong tries. Locked for 15 minutes."
      : "Could not reach the server. Check your connection."
    );
  }

  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center bg-[#050507] px-6">
      <div className="w-full max-w-[300px]">
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.04]">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-slate-300">
            <rect x="4" y="10" width="16" height="11" rx="2.5" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
        </div>
        <h1 className="text-center text-lg font-semibold text-white">VidShelf is locked</h1>
        <p className="t-small mt-1.5 text-center text-slate-400">Enter your PIN to continue</p>
        <form
          className="mt-6"
          onSubmit={(e) => { e.preventDefault(); void submit(pin); }}
        >
          <input
            ref={inputRef}
            data-focusable
            data-autofocus
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={pin}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "").slice(0, 8);
              setPin(v);
              setErr("");
              if (v.length >= 6) void submit(v);
            }}
            onKeyDown={(e) => {
              // The global TV key handler would treat Enter as "blur the
              // field"; here it must mean submit. Stop it from bubbling.
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                void submit(pin);
              }
            }}
            placeholder="PIN"
            className={`w-full min-w-0 rounded-2xl border bg-white/[0.04] px-4 py-3.5 text-center text-xl font-semibold tracking-[0.4em] text-white placeholder:text-slate-600 focus:outline-none ${err ? "border-red-400/50" : "border-white/[0.1] focus:border-white/25"}`}
          />
          {err && <p className="t-small mt-2.5 text-center text-red-300">{err}</p>}
          <button
            type="submit"
            data-focusable
            disabled={busy || pin.length < 4}
            className="mt-4 w-full rounded-2xl bg-white py-3 text-[15px] font-semibold text-black transition-opacity disabled:opacity-40"
          >
            {busy ? "Unlocking..." : "Unlock"}
          </button>
        </form>
      </div>
    </div>
  );
}
