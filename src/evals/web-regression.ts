import { webFetch, webSearch } from "../tools/web";

type SearchEvalCase = {
  name: string;
  kind: "search";
  input: {
    query: string;
    max_results?: number;
  };
  expectMinResults?: number;
  expectTitleIncludes?: string[];
  expectUrlIncludes?: string[];
  rejectTitleIncludes?: string[];
};

type FetchEvalCase = {
  name: string;
  kind: "fetch";
  input: {
    url: string;
  };
  expectTextIncludes?: string[];
  rejectTextIncludes?: string[];
  expectNotError?: boolean;
};

type EvalCase = SearchEvalCase | FetchEvalCase;

type CaseResult = {
  name: string;
  kind: EvalCase["kind"];
  passed: boolean;
  errors: string[];
  summary: string;
};

export const CASES: EvalCase[] = [
  {
    name: "search_current_news_has_results",
    kind: "search",
    input: {
      query: "today top news",
      max_results: 5,
    },
    expectMinResults: 3,
  },
  {
    name: "search_openai_returns_relevant_match",
    kind: "search",
    input: {
      query: "OpenAI latest news",
      max_results: 5,
    },
    expectMinResults: 1,
    expectTitleIncludes: ["openai"],
  },
  {
    name: "search_should_not_fall_into_irrelevant_old_tech_post",
    kind: "search",
    input: {
      query: "today top news",
      max_results: 5,
    },
    rejectTitleIncludes: ["squeakjs", "webassembly components"],
  },
  {
    name: "fetch_hacker_news_returns_page_text",
    kind: "fetch",
    input: {
      url: "https://news.ycombinator.com/",
    },
    expectNotError: true,
    expectTextIncludes: ["Hacker News", "comments"],
  },
  {
    name: "fetch_invalid_url_rejected",
    kind: "fetch",
    input: {
      url: "example.com",
    },
    rejectTextIncludes: ["# "],
  },
];

export function includesCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export async function runSearchCase(testCase: SearchEvalCase): Promise<CaseResult> {
  const errors: string[] = [];
  const raw = await webSearch(testCase.input);
  let parsed: any;

  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push("search output is not valid JSON");
    return {
      name: testCase.name,
      kind: testCase.kind,
      passed: false,
      errors,
      summary: raw.slice(0, 160),
    };
  }

  if (parsed.error) {
    errors.push(`search returned error: ${parsed.error}`);
  }

  const results = Array.isArray(parsed.results) ? parsed.results : [];
  if ((testCase.expectMinResults ?? 0) > results.length) {
    errors.push(`expected at least ${testCase.expectMinResults} results, got ${results.length}`);
  }

  if (testCase.expectTitleIncludes && testCase.expectTitleIncludes.length > 0) {
    const titles = results.map((item: any) => String(item.title ?? ""));
    for (const keyword of testCase.expectTitleIncludes) {
      if (!titles.some((title: string) => includesCI(title, keyword))) {
        errors.push(`no result title included '${keyword}'`);
      }
    }
  }

  if (testCase.expectUrlIncludes && testCase.expectUrlIncludes.length > 0) {
    const urls = results.map((item: any) => String(item.url ?? ""));
    for (const keyword of testCase.expectUrlIncludes) {
      if (!urls.some((url: string) => includesCI(url, keyword))) {
        errors.push(`no result url included '${keyword}'`);
      }
    }
  }

  if (testCase.rejectTitleIncludes && testCase.rejectTitleIncludes.length > 0) {
    const titles = results.map((item: any) => String(item.title ?? ""));
    for (const keyword of testCase.rejectTitleIncludes) {
      if (titles.some((title: string) => includesCI(title, keyword))) {
        errors.push(`found rejected title keyword '${keyword}'`);
      }
    }
  }

  const topTitle = String(results[0]?.title ?? "(none)");
  return {
    name: testCase.name,
    kind: testCase.kind,
    passed: errors.length === 0,
    errors,
    summary: `results=${results.length}, top=${topTitle}`,
  };
}

export async function runFetchCase(testCase: FetchEvalCase): Promise<CaseResult> {
  const errors: string[] = [];
  const output = await webFetch(testCase.input);

  if (testCase.expectNotError && output.startsWith("Error:")) {
    errors.push(`unexpected fetch error: ${output}`);
  }

  if (testCase.expectTextIncludes) {
    for (const keyword of testCase.expectTextIncludes) {
      if (!includesCI(output, keyword)) {
        errors.push(`output missing '${keyword}'`);
      }
    }
  }

  if (testCase.rejectTextIncludes) {
    for (const keyword of testCase.rejectTextIncludes) {
      if (includesCI(output, keyword)) {
        errors.push(`output unexpectedly included '${keyword}'`);
      }
    }
  }

  return {
    name: testCase.name,
    kind: testCase.kind,
    passed: errors.length === 0,
    errors,
    summary: output.slice(0, 140).replace(/\s+/g, " "),
  };
}

export async function runCase(testCase: EvalCase): Promise<CaseResult> {
  if (testCase.kind === "search") return await runSearchCase(testCase);
  return await runFetchCase(testCase);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const results: CaseResult[] = [];

  for (const testCase of CASES) {
    results.push(await runCase(testCase));
  }

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;

  console.log("Web Regression Eval");
  console.log(`cases: ${results.length}`);
  console.log(`pass rate: ${formatPercent(passed / results.length)} (${passed}/${results.length})`);
  console.log(`failed: ${failed}`);
  console.log(`elapsed_ms: ${Date.now() - startedAt}`);
  console.log("");

  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} [${result.kind}] ${result.name}`);
    console.log(`  summary: ${result.summary || "(empty)"}`);
    for (const error of result.errors) {
      console.log(`  - ${error}`);
    }
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
