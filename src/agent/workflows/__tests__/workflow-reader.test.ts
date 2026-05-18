import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWorkflowFile, validateWorkflowDefinition } from "../workflow-reader";

describe("workflow reader", () => {
  test("reads and validates a yaml workflow file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "helixent-workflow-reader-"));
    const path = join(cwd, "business-brief.workflow.yaml");
    await Bun.write(
      path,
      [
        "id: business-brief",
        "name: Business Brief",
        "version: 1",
        "agentTypes: [gma, rm]",
        "steps:",
        "  - id: query_metrics",
        "    type: tool",
        "    tool: erp.query_metrics",
        "  - id: generate_brief",
        "    type: agent",
        "    skill: business-analysis",
      ].join("\n"),
    );

    const workflow = await readWorkflowFile(path);

    expect(workflow).toMatchObject({
      id: "business-brief",
      name: "Business Brief",
      version: 1,
      agentTypes: ["gma", "rm"],
      steps: [
        { id: "query_metrics", type: "tool", tool: "erp.query_metrics" },
        { id: "generate_brief", type: "agent", skill: "business-analysis" },
      ],
    });
  });

  test("rejects duplicate step ids", () => {
    expect(() =>
      validateWorkflowDefinition({
        id: "invalid",
        name: "Invalid",
        version: 1,
        steps: [
          { id: "same", type: "tool", tool: "echo" },
          { id: "same", type: "agent" },
        ],
      }),
    ).toThrow('Duplicate workflow step id "same"');
  });
});
