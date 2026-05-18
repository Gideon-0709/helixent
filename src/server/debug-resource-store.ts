import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { createGmaAgentPrompt } from "@/coding/agents/lead-agent-prompt";

export type DebugResourceType = "prompt" | "skill" | "tool" | "workflow";
export type DebugReadableResourceType = DebugResourceType | "archive";

export interface DebugResource {
  id: string;
  type: DebugReadableResourceType;
  name: string;
  content: string;
  path: string;
  language: "json" | "markdown" | "typescript" | "xml" | "yaml";
  active: boolean;
  readOnly?: boolean;
}

export type DebugResourceMap = Record<DebugReadableResourceType, DebugResource[]>;

export interface DebugResourceStore {
  listResources(): Promise<DebugResourceMap>;
  createResource(input: { type: DebugResourceType; name: string }): Promise<DebugResource>;
  updateResource(input: { type: DebugResourceType; id: string; content: string }): Promise<DebugResource>;
  deleteResource(input: { type: DebugReadableResourceType; id: string }): Promise<DebugResource>;
  getActivePromptContent(): Promise<string>;
}

export function createDebugResourceStore({ cwd = process.cwd() }: { cwd?: string } = {}): DebugResourceStore {
  const promptPath = join(cwd, ".helixent/debug-panel/prompts/system.md");
  const archivesDir = join(cwd, ".helixent/debug-panel/archives");

  return {
    async listResources() {
      await ensureDefaultPrompt(promptPath, cwd);
      return {
        prompt: [await readResource({ id: "system", type: "prompt", name: "System Prompt", path: promptPath, active: true })],
        skill: await listSkillResources(cwd),
        tool: await listToolResources(cwd),
        workflow: await listWorkflowResources(cwd),
        archive: await listArchiveResources(archivesDir),
      };
    },

    async createResource({ type, name }) {
      const slug = slugify(name);
      if (!slug) {
        throw new Error("Resource name is required.");
      }
      if (type === "prompt") {
        const path = join(cwd, `.helixent/debug-panel/prompts/${slug}.md`);
        await writeNewFile(path, createPromptTemplate(name));
        return readResource({ id: slug, type, name, path, active: false });
      }
      if (type === "skill") {
        const path = join(cwd, `skills/${slug}/SKILL.md`);
        await writeNewFile(path, createSkillTemplate(name));
        return readResource({ id: slug, type, name: slug, path, active: true });
      }
      if (type === "workflow") {
        const path = join(cwd, `workflows/${slug}.workflow.yaml`);
        await writeNewFile(path, createWorkflowTemplate(slug, name));
        return readResource({ id: slug, type, name: slug, path, active: true });
      }
      const path = join(cwd, `src/coding/tools/${slug}.ts`);
      await writeNewFile(path, createToolTemplate(slug));
      return readResource({ id: slug, type, name: slug, path, active: false });
    },

    async updateResource({ type, id, content }) {
      const resource = await findResource(cwd, type, id);
      if (!resource) {
        throw new Error(`Resource ${type}/${id} was not found.`);
      }
      await Bun.write(resource.path, content);
      return readResource(resource);
    },

    async deleteResource({ type, id }) {
      const resource = await findResource(cwd, type, id);
      if (!resource) {
        throw new Error(`Resource ${type}/${id} was not found.`);
      }
      const deleted = await readResource(resource);
      await rm(resource.path);
      return deleted;
    },

    async getActivePromptContent() {
      await ensureDefaultPrompt(promptPath, cwd);
      return Bun.file(promptPath).text();
    },
  };
}

async function listSkillResources(cwd: string): Promise<DebugResource[]> {
  const skillsDir = join(cwd, "skills");
  const entries = await safeReaddir(skillsDir);
  const resources = await Promise.all(
    entries.map(async (entry) => {
      const path = join(skillsDir, entry, "SKILL.md");
      if (!(await Bun.file(path).exists())) return null;
      return readResource({ id: slugify(entry), type: "skill", name: entry, path, active: true });
    }),
  );
  return resources.filter((resource) => resource !== null).sort(compareResource);
}

async function listToolResources(cwd: string): Promise<DebugResource[]> {
  const toolsDir = join(cwd, "src/coding/tools");
  const entries = await safeReaddir(toolsDir);
  const resources = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) => !["tool-result.ts", "tool-utils.ts", "ask-user-question-manager.ts"].includes(entry))
      .map(async (entry) => {
        const name = basename(entry, ".ts");
        return readResource({ id: slugify(name), type: "tool", name, path: join(toolsDir, entry), active: true });
      }),
  );
  return resources.sort(compareResource);
}

async function listWorkflowResources(cwd: string): Promise<DebugResource[]> {
  const workflowsDir = join(cwd, "workflows");
  const entries = await safeReaddir(workflowsDir);
  const resources = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".workflow.yaml") || entry.endsWith(".workflow.yml") || entry.endsWith(".workflow.json"))
      .map(async (entry) => {
        const name = entry
          .replace(/\.workflow\.(yaml|yml|json)$/u, "");
        return readResource({ id: slugify(name), type: "workflow", name, path: join(workflowsDir, entry), active: true });
      }),
  );
  return resources.sort(compareResource);
}

async function listArchiveResources(archivesDir: string): Promise<DebugResource[]> {
  const entries = await safeReaddir(archivesDir);
  const resources = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => {
        const name = basename(entry, ".json");
        return readResource({ id: slugify(name), type: "archive", name, path: join(archivesDir, entry), active: true, readOnly: true });
      }),
  );
  return resources.sort((a, b) => b.name.localeCompare(a.name));
}

async function findResource(cwd: string, type: DebugReadableResourceType, id: string): Promise<Omit<DebugResource, "content" | "language"> | null> {
  const resources = await createDebugResourceStore({ cwd }).listResources();
  return resources[type].find((resource) => resource.id === id) ?? null;
}

async function readResource(resource: Omit<DebugResource, "content" | "language">): Promise<DebugResource> {
  return {
    ...resource,
    content: await Bun.file(resource.path).text(),
    language: languageFor(resource.type),
  };
}

async function ensureDefaultPrompt(path: string, cwd: string) {
  if (await Bun.file(path).exists()) return;
  await Bun.write(path, createGmaAgentPrompt(cwd));
}

async function writeNewFile(path: string, content: string) {
  if (await Bun.file(path).exists()) {
    throw new Error(`Resource file already exists: ${path}`);
  }
  await Bun.write(path, content);
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

function languageFor(type: DebugReadableResourceType): DebugResource["language"] {
  if (type === "archive") return "json";
  if (type === "tool") return "typescript";
  if (type === "skill") return "markdown";
  if (type === "workflow") return "yaml";
  return "xml";
}

function compareResource(a: DebugResource, b: DebugResource): number {
  return a.name.localeCompare(b.name);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createPromptTemplate(name: string): string {
  return `<agent name="${name}" role="debug_agent">\nDescribe the agent behavior for this prompt.\n</agent>\n`;
}

function createSkillTemplate(name: string): string {
  return `---\nname: ${slugify(name)}\ndescription: Describe when this skill should be used.\n---\n\n# ${name}\n\nDescribe the workflow here.\n`;
}

function createToolTemplate(name: string): string {
  const exportName = `${camelCase(name)}Tool`;
  return `import z from "zod";\n\nimport { defineTool } from "@/foundation";\n\nimport { okToolResult } from "./tool-result";\n\nexport const ${exportName} = defineTool({\n  name: "${name}",\n  description: "Describe what this tool does.",\n  parameters: z.object({\n    description: z.string().describe("Explain why you want to use this tool."),\n  }),\n  invoke: async ({ description }) => okToolResult("Tool executed.", { description }),\n});\n`;
}

function createWorkflowTemplate(id: string, name: string): string {
  return `id: ${id}\nname: ${name}\nversion: 1\n\ninputs:\n  cwd:\n    type: string\n    required: true\n    description: Absolute workspace path to inspect.\n\nsteps:\n  - id: inspect\n    name: Inspect\n    type: tool\n    tool: list_files\n    input:\n      description: Inspect the workspace before continuing.\n      path: $input.cwd\n      recursive: false\n`;
}

function camelCase(value: string): string {
  const [first = "debug", ...rest] = value.split(/[-_]/).filter(Boolean);
  return first + rest.map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
}
