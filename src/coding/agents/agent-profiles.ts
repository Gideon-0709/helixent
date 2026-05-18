export type AgentType = "gma" | "rm" | "sm";

export interface AgentProfile {
  type: AgentType;
  name: string;
  role: string;
  description: string;
}

export const AGENT_PROFILES = {
  gma: {
    type: "gma",
    name: "GMA",
    role: "general_manager_assistant",
    description: "A general manager assistant agent",
  },
  rm: {
    type: "rm",
    name: "RM",
    role: "regional_manager",
    description: "A regional manager agent",
  },
  sm: {
    type: "sm",
    name: "SM",
    role: "store_manager",
    description: "A store manager agent",
  },
} satisfies Record<AgentType, AgentProfile>;

export function isAgentType(value: unknown): value is AgentType {
  return typeof value === "string" && value in AGENT_PROFILES;
}
