import { describe, it, expect } from "vitest";
import { parseLink } from "../router";

const ID = "dQw4w9WgXcQ";
const FID = "1AbCdEfGhIjKlMnOpQrStUvWxYz12345";

describe("parseLink: youtube", () => {
  const cases = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://music.youtube.com/watch?v=${ID}&list=RDxyz`,
    `https://m.youtube.com/watch?v=${ID}`,
    `youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/live/${ID}`,
  ];
  for (const url of cases) {
    it(`parses ${url}`, () => {
      const p = parseLink(url);
      expect(p.kind).toBe("youtube");
      expect(p.videoId).toBe(ID);
      expect(p.playUrl).toContain(`?v=${ID}`);
      expect(p.playUrl).toMatch(/^https:\/\//);
    });
  }
  it("rejects bad ids", () => {
    expect(parseLink("https://youtube.com/watch?v=short").kind).not.toBe("youtube");
  });
});

describe("parseLink: drive (removed - home server replaces it)", () => {
  const cases = [
    `https://drive.google.com/file/d/${FID}/view?usp=sharing`,
    `https://drive.google.com/file/d/${FID}/preview`,
    `https://drive.google.com/open?id=${FID}`,
    `https://drive.google.com/uc?id=${FID}&export=download`,
  ];
  for (const url of cases) {
    it(`blocks ${url}`, () => {
      const p = parseLink(url);
      expect(p.kind).toBe("unknown");
      expect(p.playUrl).toBeNull();
      expect(p.blockReason).toContain("no longer supported");
    });
  }
});

describe("parseLink: r2 home-server media", () => {
  const mid = "9f2b7c1ad4e84f0a8c3d5e6b";
  it("parses r2:// urls to the worker stream route", () => {
    const p = parseLink(`r2://${mid}`);
    expect(p.kind).toBe("r2");
    expect(p.playUrl).toBe(`https://vidshelf-sync.shubhoeducation.workers.dev/media/stream/${mid}`);
    expect(p.label).toBe("Home server");
  });
  it("rejects short/garbage ids", () => {
    expect(parseLink("r2://short").kind).not.toBe("r2");
    expect(parseLink("r2://").kind).not.toBe("r2");
  });
});

describe("parseLink: direct + hls", () => {
  it("detects mp4", () => {
    const p = parseLink("https://cdn.example.com/movies/film.mp4");
    expect(p.kind).toBe("direct");
    expect(p.playUrl).toBe("https://cdn.example.com/movies/film.mp4");
  });
  it("detects m3u8 with query", () => {
    const p = parseLink("https://cdn.example.com/out/master.m3u8?token=abc");
    expect(p.kind).toBe("hls");
  });
});

describe("parseLink: ott + unknown", () => {
  for (const [url, name] of [
    ["https://www.netflix.com/watch/81234567", "Netflix"],
    ["https://www.primevideo.com/detail/0XYZ", "Prime Video"],
    ["https://www.hotstar.com/in/shows/x/1", "Hotstar"],
    ["https://www.zee5.com/movies/details/x/0-0-1", "ZEE5"],
  ] as const) {
    it(`blocks ${name}`, () => {
      const p = parseLink(url);
      expect(p.kind).toBe("ott");
      expect(p.playUrl).toBeNull();
      expect(p.blockReason).toContain(name);
    });
  }
  it("flags garbage", () => {
    expect(parseLink("not a url at all :::").kind).toBe("unknown");
    expect(parseLink("https://example.com/page").kind).toBe("unknown");
  });
});
