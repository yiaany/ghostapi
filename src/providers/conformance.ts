import type { ProviderPack, ProviderRuntime } from "./types.js";
import { assertProviderStateTransition, prepareProviderPackExecution } from "./runtime.js";

export type ProviderConformanceResult = {
  provider: string;
  apiVersion: string;
  fixtures: number;
};

export function runProviderPackConformance(pack: ProviderPack, runtime: ProviderRuntime): ProviderConformanceResult {
  if (pack.manifest.name !== pack.name || pack.manifest.displayName !== pack.displayName) {
    throw new Error(`Provider pack ${pack.name} manifest identity does not match the pack.`);
  }
  if (!pack.manifest.apiVersions.supported.includes(pack.manifest.apiVersions.default)) {
    throw new Error(`Provider pack ${pack.name} default API version is not declared as supported.`);
  }
  if (pack.conformanceFixtures.length === 0) {
    throw new Error(`Provider pack ${pack.name} must declare at least one conformance fixture.`);
  }

  let apiVersion = pack.manifest.apiVersions.default;

  for (const fixture of pack.conformanceFixtures) {
    const prepared = prepareProviderPackExecution(pack, fixture.request, runtime);
    if ("error" in prepared) {
      throw new Error(`Conformance fixture "${fixture.name}" rejected API version: ${prepared.error.message}`);
    }

    apiVersion = prepared.apiVersion;
    const validationError = pack.validate(prepared.parsedRequest, fixture.request);
    if (validationError !== null) {
      throw new Error(`Conformance fixture "${fixture.name}" failed request validation: ${validationError.message}`);
    }

    const response = pack.handleDeterministic({
      request: fixture.request,
      parsedRequest: prepared.parsedRequest,
      apiVersion: prepared.apiVersion,
      runtime
    });
    const responseError = fixture.assertResponse(response);
    if (responseError !== null) {
      throw new Error(`Conformance fixture "${fixture.name}" response: ${responseError}`);
    }

    const transition = pack.transitionState({
      request: fixture.request,
      response,
      apiVersion: prepared.apiVersion,
      runtime
    });
    if (transition !== null) assertProviderStateTransition(pack, transition);
    const transitionError = fixture.assertStateTransition(transition, response);
    if (transitionError !== null) {
      throw new Error(`Conformance fixture "${fixture.name}" state transition: ${transitionError}`);
    }
  }

  return { provider: pack.name, apiVersion, fixtures: pack.conformanceFixtures.length };
}
