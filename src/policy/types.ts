export type NetworkAction = "allow" | "deny";
export type EnforcementMode = "linux-network-namespace" | "proxy-guidance";

export type NetworkRule = {
  host?: string;
  provider?: string;
};

export type GhostApiPolicy = {
  version: 1;
  network: {
    default: NetworkAction;
    allow: NetworkRule[];
    deny: NetworkRule[];
    productionHosts: string[];
  };
  credentials: {
    forbid: string[];
  };
  requiredScenarios: string[];
  enforcement: {
    allowedModes: EnforcementMode[];
  };
  reports: {
    maxProductionEgressAttempts: number;
    maxForbiddenCredentialMatches: number;
  };
};

export type PolicyEvent =
  | { type: "network"; host: string; provider?: string }
  | { type: "credential"; value: string }
  | { type: "scenario"; scenarioId: string; completedScenarioIds: readonly string[] }
  | { type: "enforcement"; mode: EnforcementMode }
  | { type: "report"; productionEgressAttempts: number; forbiddenCredentialMatches: number };

export type PolicyDecision = {
  allowed: boolean;
  reason: string;
  trace: string[];
};
