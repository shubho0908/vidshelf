import { useEffect } from "react";
import { useHashRoute } from "./lib/route";
import { clearFocus, focusFirst, installGlobalKeys } from "./lib/focus";
import LibraryView from "./views/LibraryView";
import EntryFormView from "./views/EntryFormView";
import PlayerView from "./views/PlayerView";

export default function App() {
  const route = useHashRoute();

  useEffect(() => {
    installGlobalKeys(() => window.history.back());
  }, []);

  // Reset remote focus on every route change
  useEffect(() => {
    clearFocus();
    const t = setTimeout(focusFirst, 60);
    return () => clearTimeout(t);
  }, [route]);

  if (route.startsWith("/play/")) {
    const [, , id, idx] = route.split("/");
    return <PlayerView id={id ?? ""} index={Math.max(0, parseInt(idx ?? "0", 10) || 0)} />;
  }
  if (route.startsWith("/edit/")) {
    const id = route.split("/")[2] ?? "";
    return <EntryFormView editId={id} />;
  }
  if (route === "/add") return <EntryFormView />;
  return <LibraryView />;
}
