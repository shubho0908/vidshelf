import { useEffect, useState } from "react";

export function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || "/");
  useEffect(() => {
    const fn = () => setHash(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", fn);
    return () => window.removeEventListener("hashchange", fn);
  }, []);
  return hash;
}

export function nav(to: string): void {
  window.location.hash = to;
}

export function goBack(fallback = "/"): void {
  if (window.history.length > 1) window.history.back();
  else nav(fallback);
}
