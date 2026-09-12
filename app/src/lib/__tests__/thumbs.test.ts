import { beforeEach, describe, expect, it } from "vitest";
import { checkRatio, ratioError, RATIO } from "../thumbmake";
import { allThumbIds, entryThumbIds, library, type Entry } from "../storage";

// same in-memory localStorage shim the existing storage tests use
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  get length() { return mem.size; },
} as Storage;

beforeEach(() => mem.clear());

describe("16:9 ratio validation (strict)", () => {
  it("accepts exact 16:9 sizes", () => {
    for (const [w, h] of [[1280, 720], [1920, 1080], [640, 360], [3840, 2160]] as const) {
      expect(checkRatio(w, h).ok, `${w}x${h}`).toBe(true);
      expect(checkRatio(w, h).actual).toBeCloseTo(RATIO, 3);
    }
  });
  it("accepts integer-rounded 16:9 (853x480)", () => {
    expect(checkRatio(853, 480).ok).toBe(true);
  });
  it("rejects 4:3, 1:1, 16:10 and portrait", () => {
    for (const [w, h] of [[1024, 768], [800, 800], [1920, 1200], [720, 1280]] as const) {
      expect(checkRatio(w, h).ok, `${w}x${h}`).toBe(false);
    }
  });
  it("error message states requirement and actual size", () => {
    const msg = ratioError(1024, 768);
    expect(msg).toContain("16:9");
    expect(msg).toContain("1024x768");
  });
});

function entryWithThumbs(): Entry {
  return {
    id: "e1",
    type: "playlist",
    title: "t",
    description: "",
    videos: [
      { id: "v1", url: "https://youtu.be/aaaaaaaaaaa", thumbId: "t_a", thumbV: 1 },
      { id: "v2", url: "https://youtu.be/bbbbbbbbbbb" },
      { id: "v3", url: "https://youtu.be/ccccccccccc", thumbId: "t_b", thumbV: 2 },
    ],
    createdAt: 1,
    updatedAt: 1,
    thumbId: "t_e",
    thumbV: 1,
  };
}

describe("thumbnail reference collection (cascade)", () => {
  it("collects entry-level + per-video thumb ids", () => {
    expect(entryThumbIds(entryWithThumbs()).sort()).toEqual(["t_a", "t_b", "t_e"]);
  });
  it("allThumbIds unions across entries", () => {
    const e1 = entryWithThumbs();
    const e2: Entry = { ...entryWithThumbs(), id: "e2", thumbId: "t_z", videos: [{ id: "v9", url: "https://youtu.be/ddddddddddd" }] };
    expect([...allThumbIds([e1, e2])].sort()).toEqual(["t_a", "t_b", "t_e", "t_z"]);
  });
  it("entries without thumbs reference nothing (no breaking change)", () => {
    const e = library.create({ type: "video", title: "x", description: "", videos: [library.makeVideo("https://youtu.be/eeeeeeeeeee")] });
    expect(entryThumbIds(e)).toEqual([]);
    expect(e.thumbId).toBeUndefined();
    library.remove(e.id);
  });
});
