import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflowPath = fileURLToPath(new URL("../.github/workflows/ghostapi-pr-safety.yml", import.meta.url));
const ciWorkflowPath = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
const gameDayWorkflowPath = fileURLToPath(new URL("../.github/workflows/ghostapi-kill-switch-game-day.yml", import.meta.url));
const safeFixturePath = fileURLToPath(new URL("../examples/ci-smoke/safe.mjs", import.meta.url));
const egressTestPath = fileURLToPath(new URL("./egressRun.test.ts", import.meta.url));

async function readWorkflow(path: string): Promise<string> {
  return (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
}

describe("GhostAPI PR safety workflow", () => {
  it("uses immutable actions, enforced execution, sanitized evidence, and safe comment boundaries", async () => {
    const workflow = await readWorkflow(workflowPath);

    expect(workflow).toContain("GHOSTAPI_VERSION: \"0.1.8\"");
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

  it("keeps the safe fixture free of authorization headers so its zero-secret policy can pass", async () => {
    const fixture = await readFile(safeFixturePath, "utf8");

    expect(fixture).toContain("ci.safe_ghostapi");
    expect(fixture).not.toMatch(/authorization\s*:/i);
    expect(fixture).not.toMatch(/bearer\s+/i);
  });
});

describe("standard CI workflow", () => {
  it("uses immutable actions and a read-only repository token", async () => {
    const workflow = await readWorkflow(ciWorkflowPath);

    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683");
    expect(workflow).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run smoke:package");
    expect(workflow).toContain("npm audit --omit=dev --audit-level=moderate");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("Hosted pilot checks");
    expect(workflow).toContain("Required Ubuntu Linux egress enforcement");
    expect(workflow).toContain("sudo apt-get install --yes util-linux iproute2 curl");
    expect(workflow).toContain("unshare --user --map-root-user --net --mount --pid --fork");
    expect(workflow).toContain('GHOSTAPI_REQUIRE_LINUX_EGRESS: "1"');
    expect(workflow).toContain("npm test -- --run test/egressRun.test.ts --reporter=verbose");
    expect(workflow).toContain("Linux egress enforcement tests must execute without skips.");
    expect(workflow).toContain("Hosted Docker build");
    expect(workflow).toContain("docker build --file hosted/Dockerfile --tag ghostapi-hosted-ci hosted");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("pull_request_target");
  });

  it("keeps platform-conditional egress assertions executable instead of skipped", async () => {
    const tests = await readWorkflow(egressTestPath);

    expect(tests).not.toMatch(/\b(?:it|test|describe)\.skip\b/);
    expect(tests).toContain('process.env.GHOSTAPI_REQUIRE_LINUX_EGRESS === "1"');
    expect(tests).toContain("if (!canRunLinuxNamespace) return expectEnforcementUnavailable();");
  });
});

describe("kill-switch game-day workflow", () => {
  it("schedules a local synthetic drill with immutable actions and no provider side effect", async () => {
    const workflow = await readWorkflow(gameDayWorkflowPath);

    expect(workflow).toContain("schedule:");
    expect(workflow).toContain('cron: "17 3 * * 1"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683");
    expect(workflow).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    expect(workflow).toContain("npm test -- --run test/safetyController.test.ts");
    expect(workflow).not.toMatch(/provider|vault|credential|webhook|curl|fetch/i);
  });
});
