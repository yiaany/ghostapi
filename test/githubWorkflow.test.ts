import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflowPath = fileURLToPath(new URL("../.github/workflows/ghostapi-pr-safety.yml", import.meta.url));

describe("GhostAPI PR safety workflow", () => {
  it("uses immutable actions, enforced execution, sanitized evidence, and safe comment boundaries", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("GHOSTAPI_VERSION: \"0.1.7\"");
    expect(workflow).toContain("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683");
    expect(workflow).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    expect(workflow).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(workflow).toContain("ghostapi run --policy examples/ci-smoke/ghostapi.policy.yaml -- npm --prefix examples/ci-smoke run test:safe");
    expect(workflow).toContain("ghostapi run --policy examples/ci-smoke/ghostapi.policy.yaml -- npm --prefix examples/ci-smoke run test:production-egress");
    expect(workflow).toContain("ghostapi evidence generate --policy examples/ci-smoke/ghostapi.policy.yaml");
    expect(workflow).toContain("if [ -n \"${{ steps.run.outputs.evidence_path }}\" ]; then");
    expect(workflow).toContain("if: ${{ always() && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository }}");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).not.toContain("pull_request_target");
  });
});
