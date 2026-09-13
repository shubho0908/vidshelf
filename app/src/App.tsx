import { useEffect, useState } from "react";
import { useHashRoute } from "./lib/route";
import { clearFocus, focusFirst, installGlobalKeys } from "./lib/focus";
import LibraryView from "./views/LibraryView";
import LockView from "./views/LockView";
import { mediaToken } from "./lib/medialock";
import EntryFormView from "./views/EntryFormView";
import PlayerView from "./views/PlayerView";

export default function App() {
  const route = useHashRoute();
  const [unlocked, setUnlocked] = useState(() => mediaToken() !== null);

  useEffect(() => {
    // While locked, back (webOS 461/Escape/Backspace) must not navigate
    // away from the lock screen - there is nothing behind it to go back to.
    installGlobalKeys(() => { if (mediaToken()) window.history.back(); });
  }, []);

  // Reset remote focus on every route change
  useEffect(() => {
    clearFocus();
    const t = setTimeout(focusFirst, 60);
    return () => clearTimeout(t);
  }, [route]);

  if (!unlocked) return <LockView onUnlock={() => setUnlocked(true)} />;

  let view: React.ReactNode;
  if (route.startsWith("/play/")) {
    const [, , id, idx] = route.split("/");
    view = <PlayerView id={id ?? ""} index={Math.max(0, parseInt(idx ?? "0", 10) || 0)} />;
  }
  else if (route.startsWith("/edit/")) {
    const id = route.split("/")[2] ?? "";
    view = <EntryFormView editId={id} />;
  }
  else if (route === "/add") view = <EntryFormView />;
  else view = <LibraryView />;
  return <div key={route} className="view-enter h-full">{view}</div>;
}
