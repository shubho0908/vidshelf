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

describe("parseLink: drive", () => {
  const cases = [
    `https://drive.google.com/file/d/${FID}/view?usp=sharing`,
    `https://drive.google.com/file/d/${FID}/preview`,
    `https://drive.google.com/open?id=${FID}`,
    `https://drive.google.com/uc?id=${FID}&export=download`,
  ];
  for (const url of cases) {
    it(`parses ${url}`, () => {
      const p = parseLink(url);
      expect(p.kind).toBe("drive");
      expect(p.fileId).toBe(FID);
      expect(p.playUrl).toBe(`https://drive.google.com/file/d/${FID}/preview`);
    });
  }
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
