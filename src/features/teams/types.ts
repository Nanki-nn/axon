export interface TeammateConfig {
  name: string;
  instruction: string;
  model?: string;
  /** 队友进程的 PID（仅在 leader 进程中有效） */
  pid?: number | null;
  /** 创建时间 ISO 字符串 */
  createdAt: string;
}

export interface TeamMessage {
  from: string;
  to: string;
  content: string;
  timestamp: string;
}
