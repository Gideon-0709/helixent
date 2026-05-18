import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDebugResourceStore } from "../debug-resource-store";

describe("createDebugResourceStore", () => {
  test("lists file-backed prompt, skill, tool, and workflow resources", async () => {
    const cwd = await createFixtureProject();
    await Bun.write(join(cwd, ".helixent/debug-panel/archives/demo-archive.json"), JSON.stringify({ type: "archive" }, null, 2));
    const store = createDebugResourceStore({ cwd });

    const resources = await store.listResources();

    expect(resources.prompt[0]).toMatchObject({ id: "system", type: "prompt", name: "System Prompt" });
    expect(resources.skill[0]).toMatchObject({ id: "demo-skill", type: "skill", name: "demo-skill" });
    expect(resources.tool[0]).toMatchObject({ id: "read-file", type: "tool", name: "read-file" });
    expect(resources.workflow[0]).toMatchObject({ id: "demo", type: "workflow", name: "demo" });
    expect(resources.archive[0]).toMatchObject({ id: "demo-archive", type: "archive", name: "demo-archive", readOnly: true });
  });

  test("updates a prompt resource and reads the saved content back", async () => {
    const cwd = await createFixtureProject();
    const store = createDebugResourceStore({ cwd });
    await store.listResources();

    await store.updateResource({ type: "prompt", id: "system", content: "custom prompt" });

    expect(await store.getActivePromptContent()).toBe("custom prompt");
  });

  test("creates a new skill resource under skills", async () => {
    const cwd = await createFixtureProject();
    const store = createDebugResourceStore({ cwd });

    const created = await store.createResource({ type: "skill", name: "Research Helper" });

    expect(created).toMatchObject({ id: "research-helper", type: "skill", name: "research-helper" });
    expect(await Bun.file(join(cwd, "skills/research-helper/SKILL.md")).text()).toContain("Research Helper");
  });

  test("creates a new workflow resource under workflows", async () => {
    const cwd = await createFixtureProject();
    const store = createDebugResourceStore({ cwd });

    const created = await store.createResource({ type: "workflow", name: "Business Brief" });

    expect(created).toMatchObject({ id: "business-brief", type: "workflow", name: "business-brief", language: "yaml" });
    expect(await Bun.file(join(cwd, "workflows/business-brief.workflow.yaml")).text()).toContain("id: business-brief");
  });

  test("deletes an archive resource from disk", async () => {
    const cwd = await createFixtureProject();
    const archivePath = join(cwd, ".helixent/debug-panel/archives/demo-archive.json");
    await Bun.write(archivePath, JSON.stringify({ type: "archive" }, null, 2));
    const store = createDebugResourceStore({ cwd });

    const deleted = await store.deleteResource({ type: "archive", id: "demo-archive" });

    expect(deleted).toMatchObject({ id: "demo-archive", type: "archive" });
    expect(await Bun.file(archivePath).exists()).toBe(false);
  });
});

async function createFixtureProject() {
  const cwd = await mkdtemp(join(tmpdir(), "helixent-resource-store-"));
  await Bun.write(join(cwd, "skills/demo-skill/SKILL.md"), "# demo-skill\n\nDemo skill.");
  await Bun.write(join(cwd, "workflows/demo.workflow.yaml"), "id: demo\nname: Demo\nversion: 1\nsteps:\n  - id: inspect\n    type: tool\n    tool: list_files\n");
  await Bun.write(join(cwd, "src/coding/tools/read-file.ts"), "export const readFileTool = {};\n");
  return cwd;
}
