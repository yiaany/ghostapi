# Discovery Questions

Ask for concrete recent behavior before presenting GhostAPI. Do not ask all questions mechanically; follow the evidence.

1. Tell me about the last integration change written or materially changed by a coding agent.
2. Which external provider made that change risky: money, messages, source control, AI spend, webhooks, or something else?
3. What happened when the team tested it?
4. Has a test, script, or agent ever hit the wrong environment? What was the impact?
5. How do you currently prevent production credentials from reaching agents or CI jobs?
6. How would a reviewer know that a pull request never contacted production?
7. Which failure modes have caused the most rework: retries, idempotency, rate limits, timeouts, malformed responses, or webhooks?
8. Describe the last duplicate side effect, such as a payment, message, ticket, or deployment. Where did detection fail?
9. How do you validate webhook signatures today? Is that test mandatory before merge?
10. What must happen in CI before an agent-authored integration change can merge?
11. Which repositories and runners could support a Linux CI experiment?
12. Which provider integration would make a pilot meaningful within two weeks?
13. What would be unsafe to store in a testing tool or evidence artifact?
14. What information would security require before allowing a developer tool to observe test execution?
15. Who owns the budget if this removes a recurring risk or release delay?
16. What would make this a must-have rather than a nice-to-have?
17. What existing tool or workaround would GhostAPI need to displace or complement?
18. What proof would make you trust a claim that production egress was blocked?
19. If the pilot catches nothing, what result would still show operational value?
20. If the pilot catches a real defect or blocks egress, what procurement or budget step could follow?

## Capture Rules

Record direct quotes only with consent. Otherwise capture a sanitized summary, the workflow, severity, current workaround, decision owner, and next evidence-producing step. Never copy credentials, source code, raw traffic, customer data, or incident details into this repository.
