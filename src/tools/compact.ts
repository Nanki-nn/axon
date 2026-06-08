/**
 * compact 工具 — 手动压缩（L3）
 *
 * LLM 主动调用此工具来压缩对话上下文。
 * 实际压缩由 agent loop 捕获 "__NEED_COMPACT__" 标记后执行。
 */

export const DEFINITION = {
  type: "function" as const,
  function: {
    name: "compact",
    description:
      "手动压缩对话历史，将早期对话摘要化以释放上下文空间。当你觉得对话太长时应主动调用。",
    parameters: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
};

/** 执行压缩标记，agent loop 识别此返回后将会触发压缩 */
export async function execute(): Promise<string> {
  return "__NEED_COMPACT__";
}
