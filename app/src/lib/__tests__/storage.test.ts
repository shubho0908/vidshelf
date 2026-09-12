import { describe, it, expect, beforeEach } from "vitest";
import { library } from "../storage";

const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

describe("library CRUD", () => {
  beforeEach(() => mem.clear());

  it("creates and reads a video entry", () => {
    const e = library.create({ type: "video", title: "Film", description: "d", videos: [library.makeVideo("https://youtu.be/dQw4w9WgXcQ")] });
    expect(library.get(e.id)?.title).toBe("Film");
    expect(library.list()).toHaveLength(1);
  });

  it("creates a playlist with multiple videos", () => {
    const e = library.create({ type: "playlist", title: "Mix", description: "", videos: [library.makeVideo("https://a.com/1.mp4"), library.makeVideo("https://a.com/2.mp4")] });
    expect(library.get(e.id)?.videos).toHaveLength(2);
  });

  it("updates title and bumps updatedAt ordering", async () => {
    const a = library.create({ type: "video", title: "A", description: "", videos: [library.makeVideo("https://a.com/a.mp4")] });
    library.create({ type: "video", title: "B", description: "", videos: [library.makeVideo("https://a.com/b.mp4")] });
    library.update(a.id, { title: "A2" });
    expect(library.get(a.id)?.title).toBe("A2");
    expect(library.list()[0].id).toBe(a.id);
  });

  it("deletes", () => {
    const e = library.create({ type: "video", title: "X", description: "", videos: [] });
    expect(library.remove(e.id)).toBe(true);
    expect(library.remove(e.id)).toBe(false);
    expect(library.list()).toHaveLength(0);
  });

  it("export/import round-trips and skips duplicates", () => {
    library.create({ type: "video", title: "A", description: "", videos: [library.makeVideo("https://a.com/a.mp4")] });
    const dump = library.exportJson();
    expect(library.importJson(dump)).toBe(0); // all duplicates
    mem.clear();
    expect(library.importJson(dump)).toBe(1);
    expect(library.list()[0].title).toBe("A");
  });

  it("survives corrupted storage", () => {
    mem.set("vidshelf.library.v1", "{not json");
    expect(library.list()).toEqual([]);
  });
});
