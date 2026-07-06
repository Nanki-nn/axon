import { afterEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import {
  dispatch,
  getDEFINITIONS,
  isToolConcurrencySafe,
  resetDeferredToolActivations,
} from "../tools";

const TEST_AXON_DIR = join(process.cwd(), ".axon");

function clean(): void {
  resetDeferredToolActivations();
  const resultDir = join(TEST_AXON_DIR, "tool-results");
  if (existsSync(resultDir)) rmSync(resultDir, { recursive: true, force: true });
}

describe("tool registry", () => {
  afterEach(clean);

  it("hides deferred tools until tool_search activates them", async () => {
    resetDeferredToolActivations();

    const before = getDEFINITIONS().map((def: any) => def.function.name);
    expect(before).toContain("tool_search");
    expect(before).toContain("task_create");
    expect(before).not.toContain("partner_create");
    expect(before).not.toContain("web_search");
    expect(before).not.toContain("web_fetch");

    const result = await dispatch("tool_search", { query: "partner_create" });
    expect(result).toContain("partner_create");

    const after = getDEFINITIONS().map((def: any) => def.function.name);
    expect(after).toContain("partner_create");
  });

  it("activates deferred web tools through tool_search", async () => {
    resetDeferredToolActivations();

    const result = await dispatch("tool_search", { query: "web_search" });
    expect(result).toContain("web_search");

    const after = getDEFINITIONS().map((def: any) => def.function.name);
    expect(after).toContain("web_search");
  });

  it("exposes concurrency metadata for read-only tools", () => {
    expect(isToolConcurrencySafe("read_file", { path: "README.md" })).toBe(true);
    expect(isToolConcurrencySafe("edit_file", { path: "README.md" })).toBe(false);
  });

  it("persists oversized tool results and returns a truncated pointer", async () => {
    const output = await dispatch("bash", {
      command: `"${process.execPath}" -e "process.stdout.write('x'.repeat(60000))"`,
    });

    expect(output.length).toBeLessThan(55_000);
    expect(output).toContain("truncated");
    expect(output).toContain("Full result saved to:");
    expect(existsSync(join(TEST_AXON_DIR, "tool-results"))).toBe(true);
  });
});
