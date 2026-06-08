import { describe, it, expect } from "vitest";
import {
  microCompact,
  estimateSize,
} from "../compaction";
import type OpenAI from "openai";

type Message = OpenAI.Chat.ChatCompletionMessageParam;

// ── 测试辅助函数 ──────────────────────────────────────────────────────────────

/** 生成 n 条用户消息 */
function makeMessages(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    role: "user" as const,
    content: `消息 ${i + 1}`,
  }));
}

/** 生成一条工具结果消息 */
function makeToolResult(content: string, id = "call_1"): Message {
  return { role: "tool" as const, content, tool_call_id: id };
}

// ── L1: microCompact ─────────────────────────────────────────────────────────

describe("microCompact", () => {
  it("工具结果不超过 3 条时不压缩", () => {
    const msgs: Message[] = [
      makeToolResult("文件内容 A", "call_1"),
      makeToolResult("文件内容 B", "call_2"),
    ];
    const result = microCompact(msgs);
    expect((result[0] as any).content).toBe("文件内容 A");
    expect((result[1] as any).content).toBe("文件内容 B");
  });

  it("超过 3 条时，旧的被替换为占位符", () => {
    const msgs: Message[] = [
      makeToolResult("A".repeat(200), "call_1"),
      makeToolResult("B".repeat(200), "call_2"),
      makeToolResult("C".repeat(200), "call_3"),
      makeToolResult("D".repeat(200), "call_4"),
    ];
    const result = microCompact(msgs);
    // 第一条（最旧）应该被压缩
    expect((result[0] as any).content).toContain("已压缩");
    // 最后三条保持原样
    expect((result[1] as any).content).toBe("B".repeat(200));
    expect((result[2] as any).content).toBe("C".repeat(200));
    expect((result[3] as any).content).toBe("D".repeat(200));
  });

  it("短内容（<=120字符）不压缩", () => {
    const shortContent = "短内容";
    const msgs: Message[] = [
      makeToolResult(shortContent, "call_1"),
      makeToolResult("B".repeat(200), "call_2"),
      makeToolResult("C".repeat(200), "call_3"),
      makeToolResult("D".repeat(200), "call_4"),
    ];
    const result = microCompact(msgs);
    // 第一条虽然是旧的，但内容太短不值得压缩
    expect((result[0] as any).content).toBe(shortContent);
  });
});

// ── estimateSize ──────────────────────────────────────────────────────────────

describe("estimateSize", () => {
  it("空数组返回 2（空 JSON 数组的长度）", () => {
    expect(estimateSize([])).toBe(2);
  });

  it("消息越多体积越大", () => {
    const small = makeMessages(5);
    const large = makeMessages(50);
    expect(estimateSize(large)).toBeGreaterThan(estimateSize(small));
  });
});
