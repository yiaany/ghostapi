import { runSubscriptionFailureWorkflow } from "../../dist/index.js";

const worldId = process.env.GHOSTAPI_WORLD_ID ?? "subscription-recovery";
const receipt = await runSubscriptionFailureWorkflow(
  worldId,
  "subscription-payment-failed",
);

console.log(
  JSON.stringify(
    {
      customerId: receipt.customerId,
      subscriptionId: receipt.subscriptionId,
      emailId: receipt.emailId,
      githubIssue: receipt.issueNumber,
      genericRestFailureId: receipt.genericFailureId,
    },
    null,
    2,
  ),
);
