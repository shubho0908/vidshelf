// Minimal spatial (arrow-key) focus manager for TV remotes and keyboards.
const FOCUSABLE = "[data-focusable]:not([disabled])";
let current: HTMLElement | null = null;

function isField(el: HTMLElement): boolean {
  const t = el.tagName.toLowerCase();
  return t === "input" || t === "textarea";
}

function visible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function getFocusable(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
}

export function setFocus(el: HTMLElement | null): void {
  if (current === el) return;
  current?.classList.remove("tv-focus");
  current = el;
  if (el) {
    el.classList.add("tv-focus");
    if (!isField(el)) el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
}

export function focusFirst(): void {
  const items = getFocusable();
  if (items.length) setFocus(items[0]);
}

export function clearFocus(): void {
  current?.classList.remove("tv-focus");
  current = null;
}

function center(r: DOMRect) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function move(dir: "up" | "down" | "left" | "right"): boolean {
  const items = getFocusable();
  if (!items.length) return false;
  (document.activeElement as HTMLElement | null)?.blur?.();
  if (!current || !document.contains(current) || !visible(current)) {
    setFocus(items[0]);
    return true;
  }
  const c = center(current.getBoundingClientRect());
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === current) continue;
    const p = center(el.getBoundingClientRect());
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    if (dir === "up" && dy >= -4) continue;
    if (dir === "down" && dy <= 4) continue;
    if (dir === "left" && dx >= -4) continue;
    if (dir === "right" && dx <= 4) continue;
    const primary = dir === "up" || dir === "down" ? Math.abs(dy) : Math.abs(dx);
    const secondary = dir === "up" || dir === "down" ? Math.abs(dx) : Math.abs(dy);
    const score = primary + secondary * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (best) {
    setFocus(best);
    return true;
  }
  return false;
}

export function activate(): void {
  if (!current) return;
  if (isField(current)) {
    if (document.activeElement === current) (current as HTMLInputElement).blur();
    else (current as HTMLInputElement).focus();
    return;
  }
  current.click();
}

export function installGlobalKeys(onBack: () => void): void {
  window.addEventListener("keydown", (e) => {
    const active = document.activeElement as HTMLElement | null;
    const tag = (active?.tagName ?? "").toLowerCase();
    const typing = (tag === "input" || tag === "textarea") && active !== current;
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        move("up");
        break;
      case "ArrowDown":
        e.preventDefault();
        move("down");
        break;
      case "ArrowLeft":
        if (!typing) {
          e.preventDefault();
          move("left");
        }
        break;
      case "ArrowRight":
        if (!typing) {
          e.preventDefault();
          move("right");
        }
        break;
      case "Enter":
        if (!typing) {
          e.preventDefault();
          activate();
        }
        break;
      case "Escape":
      case "Backspace":
        if (!typing) {
          e.preventDefault();
          onBack();
        }
        break;
    }
    // webOS TV remote back button
    if ((e as KeyboardEvent & { keyCode?: number }).keyCode === 461) {
      e.preventDefault();
      onBack();
    }
  });
}
