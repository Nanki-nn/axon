import { describe, expect, it, vi, afterEach } from "vitest";
import * as webTools from "../tools/web";
import { runFetchCase, runSearchCase } from "../evals/web-regression";

describe("web regression eval helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes a search case when minimum results and keyword checks succeed", async () => {
    vi.spyOn(webTools, "webSearch").mockResolvedValue(JSON.stringify({
      query: "openai latest news",
      total_results: 2,
      results: [
        { title: "OpenAI launches new feature", url: "https://example.com", snippet: "..." },
        { title: "More OpenAI updates", url: "https://example.org", snippet: "..." },
      ],
    }));

    const result = await runSearchCase({
      name: "search_case",
      kind: "search",
      input: { query: "openai latest news" },
      expectMinResults: 1,
      expectTitleIncludes: ["openai"],
    });

    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails a fetch case when expected text is missing", async () => {
    vi.spyOn(webTools, "webFetch").mockResolvedValue("# Example\n\nOnly intro");

    const result = await runFetchCase({
      name: "fetch_case",
      kind: "fetch",
      input: { url: "https://example.com" },
      expectNotError: true,
      expectTextIncludes: ["comments"],
    });

    expect(result.passed).toBe(false);
    expect(result.errors[0]).toContain("missing");
  });
});
