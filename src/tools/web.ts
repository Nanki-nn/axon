import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "../logger";

const execFileAsync = promisify(execFile);

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const DEFAULT_SEARCH_MAX_RESULTS = 5;
const MAX_SEARCH_RESULTS = 10;
const FETCH_MAX_CHARS = 12_000;
const FETCH_TIMEOUT_MS = 15_000;
const JINA_READER_ENDPOINT = "https://r.jina.ai/";
const SERPER_SEARCH_ENDPOINT = "https://google.serper.dev/search";
const DUCKDUCKGO_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const GOOGLE_NEWS_RSS_ENDPOINT = "https://news.google.com/rss/search";

type FetchLikeResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<any>;
};

function clampMaxResults(value: unknown, fallback = DEFAULT_SEARCH_MAX_RESULTS): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(1, parsed), MAX_SEARCH_RESULTS);
}

function normalizeQuery(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeUrl(value: unknown): string {
  return String(value ?? "").trim();
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function getSerperApiKey(): string | null {
  const apiKey = process.env.SERPER_API_KEY?.trim();
  return apiKey ? apiKey : null;
}

function getJinaApiKey(): string | null {
  const apiKey = process.env.JINA_API_KEY?.trim();
  return apiKey ? apiKey : null;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated]`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function cleanupFetchedContent(raw: string): string {
  const text = raw
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return truncateText(text, FETCH_MAX_CHARS);
}

function normalizeDuckDuckGoUrl(rawUrl: string): string {
  const trimmed = decodeHtmlEntities(rawUrl).trim();
  if (!trimmed) return "";
  try {
    const resolved = new URL(trimmed, "https://duckduckgo.com");
    const redirected = resolved.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : resolved.toString();
  } catch {
    return trimmed;
  }
}

function extractDuckDuckGoResults(html: string, maxResults: number): WebSearchResult[] {
  const anchorPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /<(?:a|div)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi;
  const snippets = Array.from(html.matchAll(snippetPattern)).map((match) => stripHtml(match[1] ?? ""));
  const results: WebSearchResult[] = [];

  for (const match of html.matchAll(anchorPattern)) {
    const url = normalizeDuckDuckGoUrl(match[1] ?? "");
    const title = stripHtml(match[2] ?? "");
    if (!title || !url) continue;
    results.push({
      title,
      url,
      snippet: snippets[results.length] ?? "",
    });
    if (results.length >= maxResults) break;
  }

  return results;
}

function extractGoogleNewsResults(xml: string, maxResults: number): WebSearchResult[] {
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  const results: WebSearchResult[] = [];

  for (const itemMatch of xml.matchAll(itemPattern)) {
    const item = itemMatch[1] ?? "";
    const title = stripHtml(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    const url = decodeHtmlEntities(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? "").trim();
    const description = stripHtml(item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? "");
    const source = stripHtml(item.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1] ?? "");
    if (!title || !url) continue;
    results.push({
      title,
      url,
      snippet: [description, source ? `Source: ${source}` : ""].filter(Boolean).join(" | "),
    });
    if (results.length >= maxResults) break;
  }

  return results;
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return stripHtml(match?.[1] ?? "");
}

function extractMainTextFromHtml(html: string): string {
  const prioritizedBlocks = [
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1],
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1],
    html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1],
  ].filter((value): value is string => Boolean(value));

  const source = prioritizedBlocks[0] ?? html;
  return stripHtml(source);
}

async function fetchWithNodeFetch(url: string, init?: RequestInit): Promise<FetchLikeResponse> {
  return await fetch(url, init);
}

async function fetchTextWithPython(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const script = `
import sys, urllib.request
url = sys.argv[1]
timeout = float(sys.argv[2])
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req, timeout=timeout) as resp:
    sys.stdout.write(resp.read().decode('utf-8', 'ignore'))
`.trim();
  const { stdout } = await execFileAsync("python3", ["-c", script, url, String(timeoutMs / 1000)], {
    timeout: timeoutMs + 1000,
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout;
}

async function fetchTextWithCurl(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync("curl", [
    "-L",
    "-sS",
    "--max-time",
    String(Math.ceil(timeoutMs / 1000)),
    "-A",
    "Mozilla/5.0",
    url,
  ], {
    timeout: timeoutMs + 1000,
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout;
}

async function fetchTextWithFallbacks(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  try {
    const response = await fetchWithNodeFetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } catch (nodeError: any) {
    logger.warn("web", `Node fetch failed for ${url}: ${nodeError?.message ?? nodeError}`);
  }

  try {
    return await fetchTextWithPython(url, timeoutMs);
  } catch (pythonError: any) {
    logger.warn("web", `Python fetch failed for ${url}: ${pythonError?.message ?? pythonError}`);
  }

  return await fetchTextWithCurl(url, timeoutMs);
}

export async function searchWithSerper(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const apiKey = getSerperApiKey();
  if (!apiKey) {
    throw new Error("SERPER_API_KEY is not configured");
  }

  const response = await fetchWithNodeFetch(SERPER_SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({
      q: query,
      num: clampMaxResults(maxResults),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Search provider returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const payload = await response.json() as { organic?: Array<Record<string, unknown>> };
  const items = Array.isArray(payload.organic) ? payload.organic : [];

  return items
    .map((item) => ({
      title: String(item.title ?? "").trim(),
      url: String(item.link ?? "").trim(),
      snippet: String(item.snippet ?? "").trim(),
    }))
    .filter((item) => item.title && item.url);
}

export async function searchWithDuckDuckGo(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const response = await fetchWithNodeFetch(DUCKDUCKGO_HTML_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "User-Agent": "Mozilla/5.0",
    },
    body: new URLSearchParams({ q: query }).toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Search provider returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const html = await response.text();
  return extractDuckDuckGoResults(html, clampMaxResults(maxResults));
}

export async function searchWithGoogleNewsRss(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const rssUrl = `${GOOGLE_NEWS_RSS_ENDPOINT}?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const xml = await fetchTextWithFallbacks(rssUrl);
  return extractGoogleNewsResults(xml, clampMaxResults(maxResults));
}

export async function fetchWithJina(url: string): Promise<string> {
  const apiKey = getJinaApiKey();

  try {
    const response = await fetchWithNodeFetch(JINA_READER_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Return-Format": "markdown",
        "X-Timeout": "15",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ url }),
    });

    if (response.ok) {
      const text = await response.text();
      if (text.trim()) {
        return cleanupFetchedContent(text);
      }
    }
  } catch (error: any) {
    logger.warn("web", `Jina POST failed: ${error?.message ?? error}`);
  }

  const directReaderUrl = `${JINA_READER_ENDPOINT}${url}`;
  const text = await fetchTextWithFallbacks(directReaderUrl);
  if (!text.trim()) {
    throw new Error("Fetch provider returned empty content");
  }
  return cleanupFetchedContent(text);
}

export async function fetchPageHtml(url: string): Promise<string> {
  return await fetchTextWithFallbacks(url);
}

async function fallbackSearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
  return await internals.searchWithGoogleNewsRss(query, maxResults);
}

export const internals = {
  searchWithSerper,
  searchWithDuckDuckGo,
  searchWithGoogleNewsRss,
  fetchWithJina,
  fetchPageHtml,
};

export const WEB_SEARCH_DEFINITION = {
  type: "function" as const,
  function: {
    name: "web_search",
    description:
      "Search the web for current information and return a concise list of relevant results. " +
      "Use this before web_fetch when you need to discover URLs.",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query describing what you want to find" },
        max_results: { type: "number", description: "Maximum number of results to return (default 5, max 10)" },
      },
      required: ["query"],
    },
  },
};

export const WEB_FETCH_DEFINITION = {
  type: "function" as const,
  function: {
    name: "web_fetch",
    description:
      "Fetch the main text content from a public web page URL. " +
      "Use this after web_search or when the user already gave you a direct URL.",
    parameters: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The full http(s) URL to fetch" },
      },
      required: ["url"],
    },
  },
};

export async function webSearch(input: { query?: unknown; max_results?: unknown }): Promise<string> {
  const query = normalizeQuery(input.query);
  if (!query) {
    return JSON.stringify({ error: "query is required" }, null, 2);
  }

  const maxResults = clampMaxResults(input.max_results);

  try {
    let results: WebSearchResult[] = [];
    if (getSerperApiKey()) {
      results = await internals.searchWithSerper(query, maxResults);
    } else {
      try {
        results = await internals.searchWithDuckDuckGo(query, maxResults);
      } catch (error: any) {
        logger.warn("web", `DuckDuckGo search failed, falling back: ${error?.message ?? error}`);
        results = await fallbackSearch(query, maxResults);
      }
    }

    if (results.length === 0) {
      return JSON.stringify({ query, total_results: 0, results: [] }, null, 2);
    }

    return JSON.stringify({
      query,
      total_results: results.length,
      results,
    }, null, 2);
  } catch (error: any) {
    logger.warn("web", `web_search failed: ${error?.message ?? error}`);
    return JSON.stringify({
      error: error?.message ?? "web_search failed",
      query,
    }, null, 2);
  }
}

export async function webFetch(input: { url?: unknown }): Promise<string> {
  const url = normalizeUrl(input.url);
  if (!url) return "Error: url is required";
  if (!isValidHttpUrl(url)) return `Error: invalid URL '${url}'. Use a full http(s) URL.`;

  try {
    return await internals.fetchWithJina(url);
  } catch (jinaError: any) {
    logger.warn("web", `Jina fetch failed, falling back to raw page fetch: ${jinaError?.message ?? jinaError}`);
  }

  try {
    const html = await internals.fetchPageHtml(url);
    const title = extractTitle(html);
    const body = extractMainTextFromHtml(html);
    const combined = [title ? `# ${title}` : "", body].filter(Boolean).join("\n\n");
    if (!combined.trim()) {
      return "Error: fetched page but could not extract readable text";
    }
    return cleanupFetchedContent(combined);
  } catch (error: any) {
    logger.warn("web", `web_fetch failed: ${error?.message ?? error}`);
    return `Error: ${error?.message ?? "web_fetch failed"}`;
  }
}
