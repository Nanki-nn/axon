import { describe, it, expect } from "vitest";
import {
  snipCompact,
  microCompact,
  toolResultBudget,
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

// ── L1: snipCompact ───────────────────────────────────────────────────────────

describe("snipCompact", () => {
  it("消息数未超限时原样返回", () => {
    const msgs = makeMessages(30);
    expect(snipCompact(msgs)).toHaveLength(30);
  });

  it("消息数超过 50 时裁剪中间", () => {
    const msgs = makeMessages(60);
    const result = snipCompact(msgs);
    // 头 3 + 占位符 1 + 尾 47 = 51
    expect(result).toHaveLength(51);
  });

  it("保留头部 3 条内容不变", () => {
    const msgs = makeMessages(60);
    const result = snipCompact(msgs);
    expect(result[0].content).toBe("消息 1");
    expect(result[1].content).toBe("消息 2");
    expect(result[2].content).toBe("消息 3");
  });

  it("保留尾部最新消息", () => {
    const msgs = makeMessages(60);
    const result = snipCompact(msgs);
    expect(result[result.length - 1].content).toBe("消息 60");
  });

  it("中间插入占位符说明裁剪了多少条", () => {
    const msgs = makeMessages(60);
    const result = snipCompact(msgs);
    const placeholder = result[3] as { role: string; content: string };
    expect(placeholder.content).toContain("已压缩");
    expect(placeholder.content).toContain("10"); // 60 - 3 - 47 = 10
  });
});

// ── L2: microCompact ──────────────────────────────────────────────────────────

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

// ── L3: toolResultBudget ──────────────────────────────────────────────────────

describe("toolResultBudget", () => {
  it("总大小未超限时不处理", () => {
    const msgs: Message[] = [
      makeToolResult("小内容", "call_1"),
    ];
    const result = toolResultBudget(msgs);
    expect((result[0] as any).content).toBe("小内容");
  });

  it("没有工具结果消息时原样返回", () => {
    const msgs = makeMessages(5);
    const result = toolResultBudget(msgs);
    expect(result).toHaveLength(5);
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
