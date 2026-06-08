import OpenAI from "openai";
import chalk from "chalk";
import { dispatch } from "./tools";

/**
 * Subagent 系统提示：比 parent 更简洁，只聚焦完成任务并汇报结果。
 * 不包含 todo / skill 系统，保持上下文轻量。
 */
const SUBAGENT_SYSTEM = `\
You are a coding subagent. Complete the given task using available tools, then summarize your findings concisely.`;

/** subagent 可用工具名集合（不含 task，避免递归派生） */
const SUBAGENT_TOOLS = new Set([
  "bash", "read_file", "write_file", "edit_file", "list_files", "search_files",
]);

/** subagent 工具定义，从 parent 的 DEFINITIONS 中按名称过滤 */
function getSubagentDefinitions(allDefs: object[]): object[] {
  return allDefs.filter((def) => {
    const name = (def as any).function?.name;
    return name && SUBAGENT_TOOLS.has(name);
  });
}

/**
 * 在独立上下文中运行子 agent，完成后只返回最终文字摘要。
 * 子 agent 的消息历史在返回后丢弃，不污染 parent context。
 */
export async function runSubagent(
  prompt: string,
  client: OpenAI,
  model: string,
  allDefinitions: object[],
): Promise<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "user", content: prompt },
  ];

  const tools = getSubagentDefinitions(allDefinitions);
  const MAX_ROUNDS = 30;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SUBAGENT_SYSTEM },
        ...messages,
      ],
      tools: tools as OpenAI.Chat.ChatCompletionTool[],
      stream: false,
    });

    const choice = response.choices[0];
    const msg = choice.message;

    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
    });

    if (choice.finish_reason !== "tool_calls") {
      // 任务完成，返回最终文字内容
      return msg.content?.trim() || "(no summary)";
    }

    // 执行工具调用，收集结果
    for (const tc of msg.tool_calls ?? []) {
      const name = tc.function.name;
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tc.function.arguments); } catch { /* ignore */ }

      console.log(chalk.dim(`  [subagent] ${name}`));
      const output = await dispatch(name, input);
      const preview = output.length > 200 ? output.slice(0, 200) + "…" : output;
      console.log(chalk.dim(`    ${preview}`));

      messages.push({ role: "tool", tool_call_id: tc.id, content: output });
    }
  }

  return "(subagent reached max rounds without finishing)";
}
