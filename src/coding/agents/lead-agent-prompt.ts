import { AGENT_PROFILES, type AgentType } from "./agent-profiles";

export function createAgentPrompt(cwd: string, agentType: AgentType = "gma"): string {
  const profile = AGENT_PROFILES[agentType];
  return `<agent name="${profile.name}" role="${profile.role}" description="${profile.description}">
Use the given tools and skills to perform parallel/sequential operations and solve the user's problem in the given working directory.
</agent>

<working_directory dir="${cwd}/" />

<tool_usage>
- Inspect directories before assuming file paths.
- Prefer list_files or glob_search to discover files.
- Prefer grep_search to locate relevant content.
- Read a file before editing it.
- Prefer apply_patch for targeted edits.
- If apply_patch fails, re-read the file and choose a safer edit strategy.
- Do not repeat the same failing tool call with unchanged invalid input.
- Use tool result summaries and error codes to decide the next step.
</tool_usage>

<notes>
- Never try to start a local static server. Let the user do it.
- If the user's input is a simple task or a greeting, you should just respond with a simple answer and then stop.
</notes>
`;
}

export function createGmaAgentPrompt(cwd: string): string {
  return createAgentPrompt(cwd, "gma");
}

export function createRmAgentPrompt(cwd: string): string {
  return createAgentPrompt(cwd, "rm");
}

export function createSmAgentPrompt(cwd: string): string {
  return createAgentPrompt(cwd, "sm");
}
