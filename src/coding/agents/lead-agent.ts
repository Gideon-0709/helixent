import { join } from "path";

import { Agent, type AgentMiddleware } from "@/agent";
import { createSkillsMiddleware } from "@/agent/skills/skills-middleware";
import { createTodoSystem } from "@/agent/todos/todos";
import type { Model, NonSystemMessage, ToolUseContent } from "@/foundation";

import {
  type ApprovalDecision,
  type ApprovalPersistence,
  CODING_TOOLS_REQUIRING_APPROVAL,
  createCodingApprovalMiddleware,
} from "../permissions";
import { applyPatchTool } from "../tools/apply-patch";
import {
  createAskUserQuestionTool,
  type AskUserQuestionParameters,
  type AskUserQuestionResult,
} from "../tools/ask-user-question";
import { bashTool } from "../tools/bash";
import { fileInfoTool } from "../tools/file-info";
import { globSearchTool } from "../tools/glob-search";
import { grepSearchTool } from "../tools/grep-search";
import { listFilesTool } from "../tools/list-files";
import { mkdirTool } from "../tools/mkdir";
import { movePathTool } from "../tools/move-path";
import { readFileTool } from "../tools/read-file";
import { strReplaceTool } from "../tools/str-replace";
import { writeFileTool } from "../tools/write-file";

import { AGENT_PROFILES, type AgentType } from "./agent-profiles";
import { createAgentPrompt, createGmaAgentPrompt } from "./lead-agent-prompt";

export const GMA_AGENT_NAME = "GMA";
export const RM_AGENT_NAME = "RM";
export const SM_AGENT_NAME = "SM";

interface CreateRoleAgentOptions {
  model: Model;
  cwd?: string;
  skillsDirs?: string[];
  prompt?: string;
  // eslint-disable-next-line no-unused-vars
  askUser?: (toolUse: ToolUseContent) => Promise<ApprovalDecision>;
  // eslint-disable-next-line no-unused-vars
  askUserQuestion?: (params: AskUserQuestionParameters) => Promise<AskUserQuestionResult>;
  approvalPersistence?: ApprovalPersistence;
  middlewares?: AgentMiddleware[];
}

export async function createRoleAgent({
  agentType = "gma",
  model,
  cwd = process.cwd(),
  skillsDirs = [join(process.cwd(), ".agents/skills")],
  askUser,
  askUserQuestion,
  approvalPersistence,
  middlewares,
  prompt,
}: CreateRoleAgentOptions & { agentType?: AgentType }) {
  const profile = AGENT_PROFILES[agentType];
  return createAgent({
    name: profile.name,
    model,
    cwd,
    skillsDirs,
    prompt: prompt ?? createAgentPrompt(cwd, agentType),
    askUser,
    askUserQuestion,
    approvalPersistence,
    extraMiddlewares: middlewares,
  });
}

export async function createGmaAgent(options: CreateRoleAgentOptions) {
  return createRoleAgent({ ...options, agentType: "gma", prompt: options.prompt ?? createGmaAgentPrompt(options.cwd ?? process.cwd()) });
}

export async function createRmAgent(options: CreateRoleAgentOptions) {
  return createRoleAgent({ ...options, agentType: "rm" });
}

export async function createSmAgent(options: CreateRoleAgentOptions) {
  return createRoleAgent({ ...options, agentType: "sm" });
}

async function createAgent({
  name,
  model,
  cwd = process.cwd(),
  skillsDirs = [join(process.cwd(), ".agents/skills")],
  askUser,
  askUserQuestion,
  approvalPersistence,
  extraMiddlewares = [],
  prompt,
}: {
  name: string;
  model: Model;
  cwd?: string;
  skillsDirs?: string[];
  prompt: string;
  // eslint-disable-next-line no-unused-vars
  askUser?: (toolUse: ToolUseContent) => Promise<ApprovalDecision>;
  // eslint-disable-next-line no-unused-vars
  askUserQuestion?: (params: AskUserQuestionParameters) => Promise<AskUserQuestionResult>;
  approvalPersistence?: ApprovalPersistence;
  extraMiddlewares?: AgentMiddleware[];
}) {
  const agentsFile = Bun.file(`${cwd}/AGENTS.md`);
  const messages: NonSystemMessage[] = [];
  if (await agentsFile.exists()) {
    const agentsFileContent = await agentsFile.text();
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: "> The `AGENTS.md` file has been automatically loaded. Here is the content:\n\n" + agentsFileContent,
        },
      ],
    });
  }
  const { tool: todoTool, middleware: todoMiddleware } = createTodoSystem();

  const askUserQuestionTool = askUserQuestion ? createAskUserQuestionTool(askUserQuestion) : null;

  const middlewares = [createSkillsMiddleware(skillsDirs), todoMiddleware, ...extraMiddlewares];
  if (askUser) {
    middlewares.push(
      createCodingApprovalMiddleware({
        cwd,
        requiresApproval: CODING_TOOLS_REQUIRING_APPROVAL,
        askUser,
        approvalPersistence,
      }),
    );
  }

  return new Agent({
    name,
    model,
    prompt,
    messages,
    tools: [
      bashTool,
      fileInfoTool,
      listFilesTool,
      globSearchTool,
      grepSearchTool,
      mkdirTool,
      movePathTool,
      readFileTool,
      writeFileTool,
      strReplaceTool,
      applyPatchTool,
      todoTool,
      ...(askUserQuestionTool ? [askUserQuestionTool] : []),
    ],
    middlewares,
  });
}
