export const PARTNER_CREATE_DEFINITION = {
  type: "function" as const,
  function: {
    name: "partner_create",
    description: "创建一个新的 AI 队友。保存配置但不启动进程。使用 partner_spawn 启动。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "队友唯一标识名" },
        instruction: { type: "string", description: "队友的角色描述和职责说明" },
        model: { type: "string", description: "队友使用的模型（可选，默认同 leader）" },
      },
      required: ["name", "instruction"],
    },
  },
};

export const PARTNER_LIST_DEFINITION = {
  type: "function" as const,
  function: {
    name: "partner_list",
    description: "列出所有已配置的 AI 队友及运行状态。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

export const PARTNER_REMOVE_DEFINITION = {
  type: "function" as const,
  function: {
    name: "partner_remove",
    description: "移除一个 AI 队友（从配置中删除并杀掉进程）。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "队友名称" },
      },
      required: ["name"],
    },
  },
};

export const PARTNER_SEND_DEFINITION = {
  type: "function" as const,
  function: {
    name: "partner_send",
    description: "发送消息给一个 AI 队友。队友下次读取收件箱时会看到。",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "目标队友名称" },
        content: { type: "string", description: "消息内容" },
      },
      required: ["to", "content"],
    },
  },
};

export const PARTNER_READ_INBOX_DEFINITION = {
  type: "function" as const,
  function: {
    name: "partner_read_inbox",
    description: "读取收件箱中来自队友的所有消息。读取后自动清空。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

export const PARTNER_BROADCAST_DEFINITION = {
  type: "function" as const,
  function: {
    name: "partner_broadcast",
    description: "广播消息给所有 AI 队友。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "要广播的消息" },
      },
      required: ["content"],
    },
  },
};

export const PARTNER_SPAWN_DEFINITION = {
  type: "function" as const,
  function: {
    name: "partner_spawn",
    description: "启动一个已配置的 AI 队友的子进程。队友会作为独立进程运行。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "队友名称" },
      },
      required: ["name"],
    },
  },
};
