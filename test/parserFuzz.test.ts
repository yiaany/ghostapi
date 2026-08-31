import { describe, expect, it } from "vitest";
import {
  ContractError,
  importOpenApiContract,
} from "../src/contracts/index.js";
import { parsePolicyYaml, PolicyValidationError } from "../src/policy/index.js";
import {
  ScenarioBundleError,
  validateScenarioBundle,
} from "../src/scenarios/scenarioBundle.js";

describe("bounded parser fuzz regressions", () => {
  it("rejects arbitrary bounded policy text through its typed error boundary", () => {
    for (const source of generatedStrings(400, 512)) {
      try {
        parsePolicyYaml(source);
      } catch (error) {
        expect(error).toBeInstanceOf(PolicyValidationError);
      }
    }
  });

  it("rejects arbitrary JSON-like inputs without parser escapes or side effects", () => {
    for (const value of generatedValues(250)) {
      try {
        importOpenApiContract(value);
      } catch (error) {
        expect(error).toBeInstanceOf(ContractError);
      }

      try {
        validateScenarioBundle(value);
      } catch (error) {
        expect(error).toBeInstanceOf(ScenarioBundleError);
      }
    }
  });
});

function* generatedStrings(
  count: number,
  maxLength: number,
): Generator<string> {
  const random = createRandom(0x51a7e);
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:{}[]&*#${\\\"'\n\r\t ";
  for (let index = 0; index < count; index += 1) {
    const length = Math.floor(random() * maxLength);
    let value = "";
    for (let character = 0; character < length; character += 1)
      value += alphabet[Math.floor(random() * alphabet.length)]!;
    yield value;
  }
}

function* generatedValues(count: number): Generator<unknown> {
  const random = createRandom(0xc0ffee);
  for (let index = 0; index < count; index += 1)
    yield generatedValue(random, 0);
}

function generatedValue(random: () => number, depth: number): unknown {
  const kind = Math.floor(random() * (depth > 4 ? 4 : 7));
  if (kind === 0) return null;
  if (kind === 1) return random() > 0.5;
  if (kind === 2) return Math.floor(random() * 1000) - 500;
  if (kind === 3) return `value-${Math.floor(random() * 1_000_000)}`;
  if (kind === 4)
    return Array.from({ length: Math.floor(random() * 6) }, () =>
      generatedValue(random, depth + 1),
    );
  const record: Record<string, unknown> = {};
  for (let index = 0; index < Math.floor(random() * 6); index += 1)
    record[`field_${index}_${Math.floor(random() * 10)}`] = generatedValue(
      random,
      depth + 1,
    );
  return record;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}
