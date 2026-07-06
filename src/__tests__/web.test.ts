import { afterEach, describe, expect, it, vi } from "vitest";
import * as webTools from "../tools/web";

function mockFetchOnce(value: any): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(value));
}

describe("web tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.SERPER_API_KEY;
  });

  it("formats normalized search results", async () => {
    mockFetchOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(`
        <html>
          <body>
            <a class="result__a" href="https://openai.com">OpenAI</a>
            <a class="result__snippet">AI research and products.</a>
          </body>
        </html>
      `),
    });

    const output = await webTools.webSearch({ query: "openai", max_results: 3 });
    const parsed = JSON.parse(output);

    expect(parsed.query).toBe("openai");
    expect(parsed.total_results).toBe(1);
    expect(parsed.results[0].url).toBe("https://openai.com/");
  });

  it("returns structured search errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    vi.spyOn(webTools.internals, "searchWithGoogleNewsRss").mockRejectedValue(new Error("still down"));

    const output = await webTools.webSearch({ query: "openai" });
    const parsed = JSON.parse(output);

    expect(parsed.error).toContain("still down");
    expect(parsed.query).toBe("openai");
  });

  it("falls back to Google News RSS when DuckDuckGo fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("duckduckgo down")));
    vi.spyOn(webTools.internals, "searchWithGoogleNewsRss").mockResolvedValue([
      {
        title: "Breaking News",
        url: "https://news.google.com/rss/articles/test",
        snippet: "Top story | Source: Example News",
      },
    ]);

    const output = await webTools.webSearch({ query: "today top news" });
    const parsed = JSON.parse(output);

    expect(parsed.total_results).toBe(1);
    expect(parsed.results[0].title).toBe("Breaking News");
  });

  it("returns fetch content from provider helper", async () => {
    mockFetchOnce({
      ok: true,
      text: vi.fn().mockResolvedValue("# Title\n\nBody"),
    });

    const output = await webTools.webFetch({ url: "https://example.com" });

    expect(output).toBe("# Title\n\nBody");
  });

  it("validates URL before fetch", async () => {
    const output = await webTools.webFetch({ url: "example.com" });
    expect(output).toContain("invalid URL");
  });

  it("falls back to raw page extraction when Jina fails", async () => {
    vi.spyOn(webTools.internals, "fetchWithJina").mockRejectedValue(new Error("jina down"));
    vi.spyOn(webTools.internals, "fetchPageHtml").mockResolvedValue(`
      <html>
        <head><title>Example Page</title></head>
        <body><main><p>Hello world</p><p>Second paragraph</p></main></body>
      </html>
    `);

    const output = await webTools.webFetch({ url: "https://example.com" });

    expect(output).toContain("# Example Page");
    expect(output).toContain("Hello world");
  });

  it("surfaces fetch provider failures", async () => {
    vi.spyOn(webTools.internals, "fetchWithJina").mockRejectedValue(new Error("jina down"));
    vi.spyOn(webTools.internals, "fetchPageHtml").mockRejectedValue(new Error("network down"));

    const output = await webTools.webFetch({ url: "https://example.com" });

    expect(output).toBe("Error: network down");
  });
});
