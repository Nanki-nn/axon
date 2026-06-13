import { existsSync, rmSync } from "fs";
import { join } from "path";
import {
  MAX_SESSION_MEMORY_BYTES,
  formatMemoriesForInjection,
  recallMemories,
  saveMemory,
} from "../features/memory";

type MemorySeed = {
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  content: string;
};

type EvalCase = {
  name: string;
  query: string;
  sideQuerySelection: string[];
  expectedRecall: string[];
  unexpectedRecall?: string[];
  alreadySurfaced?: string[];
  sessionMemoryBytes?: number;
  expectSideQueryCalled?: boolean;
  expectTruncated?: boolean;
};

type CaseResult = {
  name: string;
  passed: boolean;
  recalled: string[];
  expectedRecall: string[];
  unexpectedRecall: string[];
  sideQueryCalled: boolean;
  errors: string[];
};

const EVAL_MEMORY_DIR = join(process.cwd(), ".tmp", "memory-offline-eval");

const LONG_CONTENT = "Long memory content.\n" + "A".repeat(6000);

const SEEDS: MemorySeed[] = [
  {
    name: "concise answer style",
    description: "User prefers concise final answers and concrete outcomes.",
    type: "user",
    content: "Keep final answers concise. Lead with the result, then mention verification.",
  },
  {
    name: "avoid unrelated expansion",
    description: "User does not want unrelated expansions when handling focused tasks.",
    type: "feedback",
    content: "When the user asks for a focused change, do not add unrelated features or broad rewrites.",
  },
  {
    name: "market research sources",
    description: "Preferred research sources for recurring market analysis tasks.",
    type: "reference",
    content: "Prefer official filings, primary documentation, and saved reference links before secondary summaries.",
  },
  {
    name: "workspace memory architecture",
    description: "The workspace uses structured markdown memory files with semantic recall.",
    type: "project",
    content: "Structured memory lives under .axon/memory/structured and uses MEMORY.md as an index.",
  },
  {
    name: "large reference note",
    description: "A large reference note used to verify truncation behavior.",
    type: "reference",
    content: LONG_CONTENT,
  },
];

const CASES: EvalCase[] = [
  {
    name: "recalls_user_style",
    query: "帮我总结一下这次任务结果",
    sideQuerySelection: ["user_concise_answer_style.md"],
    expectedRecall: ["user_concise_answer_style.md"],
    unexpectedRecall: ["reference_market_research_sources.md"],
  },
  {
    name: "recalls_reference_source",
    query: "继续做市场分析资料整理，先看常用资料来源",
    sideQuerySelection: ["reference_market_research_sources.md"],
    expectedRecall: ["reference_market_research_sources.md"],
    unexpectedRecall: ["user_concise_answer_style.md"],
  },
  {
    name: "filters_already_surfaced",
    query: "继续处理结构化记忆方案",
    sideQuerySelection: ["project_workspace_memory_architecture.md"],
    expectedRecall: [],
    alreadySurfaced: ["project_workspace_memory_architecture.md"],
  },
  {
    name: "skips_short_query",
    query: "ok",
    sideQuerySelection: ["user_concise_answer_style.md"],
    expectedRecall: [],
    expectSideQueryCalled: false,
  },
  {
    name: "skips_when_budget_exhausted",
    query: "继续处理结构化记忆方案",
    sideQuerySelection: ["project_workspace_memory_architecture.md"],
    expectedRecall: [],
    sessionMemoryBytes: MAX_SESSION_MEMORY_BYTES,
    expectSideQueryCalled: false,
  },
  {
    name: "limits_to_top_five",
    query: "请根据历史偏好和参考资料继续规划任务",
    sideQuerySelection: [
      "user_concise_answer_style.md",
      "feedback_avoid_unrelated_expansion.md",
      "reference_market_research_sources.md",
      "project_workspace_memory_architecture.md",
      "reference_large_reference_note.md",
      "missing_extra.md",
    ],
    expectedRecall: [
      "user_concise_answer_style.md",
      "feedback_avoid_unrelated_expansion.md",
      "reference_market_research_sources.md",
      "project_workspace_memory_architecture.md",
      "reference_large_reference_note.md",
    ],
  },
  {
    name: "truncates_large_memory",
    query: "查看大型参考资料",
    sideQuerySelection: ["reference_large_reference_note.md"],
    expectedRecall: ["reference_large_reference_note.md"],
    expectTruncated: true,
  },
];

function resetEvalDir(): void {
  if (existsSync(EVAL_MEMORY_DIR)) {
    rmSync(EVAL_MEMORY_DIR, { recursive: true, force: true });
  }
}

function seedMemories(): Map<string, string> {
  const pathsByFilename = new Map<string, string>();
  for (const seed of SEEDS) {
    const filename = saveMemory(seed);
    pathsByFilename.set(filename, join(EVAL_MEMORY_DIR, filename));
  }
  return pathsByFilename;
}

function includesAll(actual: string[], expected: string[]): string[] {
  return expected.filter((filename) => !actual.includes(filename));
}

function intersects(actual: string[], unexpected: string[]): string[] {
  return unexpected.filter((filename) => actual.includes(filename));
}

async function runCase(testCase: EvalCase, pathsByFilename: Map<string, string>): Promise<CaseResult> {
  const errors: string[] = [];
  let sideQueryCalled = false;
  const alreadySurfaced = new Set<string>();
  for (const filename of testCase.alreadySurfaced || []) {
    const fullPath = pathsByFilename.get(filename);
    if (fullPath) alreadySurfaced.add(fullPath);
  }

  const memories = await recallMemories(
    testCase.query,
    async (_system, userMessage) => {
      sideQueryCalled = true;
      for (const filename of testCase.sideQuerySelection) {
        if (
          filename !== "missing_extra.md" &&
          !(testCase.alreadySurfaced || []).includes(filename) &&
          !userMessage.includes(filename)
        ) {
          errors.push(`manifest did not include ${filename}`);
        }
      }
      return JSON.stringify({ selected_memories: testCase.sideQuerySelection });
    },
    alreadySurfaced,
    testCase.sessionMemoryBytes ?? 0,
  );

  const recalled = memories.map((memory) => memory.path.split("/").pop() || memory.path);
  const missing = includesAll(recalled, testCase.expectedRecall);
  const unexpected = intersects(recalled, testCase.unexpectedRecall || []);

  if (missing.length > 0) errors.push(`missing expected recall: ${missing.join(", ")}`);
  if (unexpected.length > 0) errors.push(`unexpected recall: ${unexpected.join(", ")}`);

  const shouldCallSideQuery = testCase.expectSideQueryCalled ?? true;
  if (sideQueryCalled !== shouldCallSideQuery) {
    errors.push(`sideQueryCalled=${sideQueryCalled}, expected ${shouldCallSideQuery}`);
  }

  if (testCase.expectTruncated) {
    const injection = formatMemoriesForInjection(memories);
    if (!injection.includes("[... truncated, memory file too large ...]")) {
      errors.push("large memory was not truncated");
    }
  }

  return {
    name: testCase.name,
    passed: errors.length === 0,
    recalled,
    expectedRecall: testCase.expectedRecall,
    unexpectedRecall: testCase.unexpectedRecall || [],
    sideQueryCalled,
    errors,
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  process.env.AXON_MEMORY_DIR = EVAL_MEMORY_DIR;
  resetEvalDir();

  try {
    const pathsByFilename = seedMemories();
    const results: CaseResult[] = [];
    for (const testCase of CASES) {
      results.push(await runCase(testCase, pathsByFilename));
    }

    const passed = results.filter((result) => result.passed).length;
    const expectedTotal = results.reduce((sum, result) => sum + result.expectedRecall.length, 0);
    const expectedHitTotal = results.reduce((sum, result) => {
      return sum + result.expectedRecall.filter((filename) => result.recalled.includes(filename)).length;
    }, 0);
    const recalledTotal = results.reduce((sum, result) => sum + result.recalled.length, 0);
    const unexpectedHitTotal = results.reduce((sum, result) => {
      return sum + result.unexpectedRecall.filter((filename) => result.recalled.includes(filename)).length;
    }, 0);
    const gateCases = results.filter((result) => result.expectedRecall.length === 0);
    const gatePasses = gateCases.filter((result) => result.recalled.length === 0).length;

    console.log("Memory Offline Eval");
    console.log(`cases: ${results.length}`);
    console.log(`pass rate: ${formatPercent(passed / results.length)} (${passed}/${results.length})`);
    console.log(`recall@5: ${expectedTotal === 0 ? "n/a" : formatPercent(expectedHitTotal / expectedTotal)}`);
    console.log(`precision proxy: ${recalledTotal === 0 ? "n/a" : formatPercent((recalledTotal - unexpectedHitTotal) / recalledTotal)}`);
    console.log(`no-recall gate accuracy: ${gateCases.length === 0 ? "n/a" : formatPercent(gatePasses / gateCases.length)}`);
    console.log("");

    for (const result of results) {
      const status = result.passed ? "PASS" : "FAIL";
      console.log(`${status} ${result.name}`);
      console.log(`  recalled: ${result.recalled.join(", ") || "(none)"}`);
      if (result.errors.length > 0) {
        for (const error of result.errors) console.log(`  - ${error}`);
      }
    }

    if (passed !== results.length) {
      process.exitCode = 1;
    }
  } finally {
    resetEvalDir();
    delete process.env.AXON_MEMORY_DIR;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
