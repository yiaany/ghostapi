import { describe, expect, it } from "vitest";
import { sanitizeSecretString, sanitizeSecrets } from "../src/security/secrets.js";
import { secretFixture } from "./fixtures/requests.js";

describe("sanitizeSecrets", () => {
  const stripeLive = ["sk", "live", "abc123"].join("_");
  const stripeTest = ["sk", "test", "abc123"].join("_");
  const stripeRestricted = ["rk", "live", "abc123"].join("_");
  const githubClassic = ["ghp", "abc123"].join("_");
  const githubFineGrained = ["github", "pat", "abc123"].join("_");

  it("masks configured secret field names without changing object shape", () => {
    expect(
      sanitizeSecrets({
        authorization: `Bearer ${stripeLive}`,
        api_key: "api-secret",
        apikey: "api-secret",
        "x-api-key": "api-secret",
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        client_secret: "client-secret",
        password: "password-secret",
        secret: "plain-secret",
        token: "token-secret",
        key: "key-secret",
        email: "test@example.com"
      })
    ).toEqual({
      authorization: "Bearer ***",
      api_key: "***",
      apikey: "***",
      "x-api-key": "***",
      access_token: "***",
      refresh_token: "***",
      client_secret: "***",
      password: "***",
      secret: "***",
      token: "***",
      key: "***",
      email: "test@example.com"
    });
  });

  it("recursively masks objects and arrays", () => {
    expect(
      sanitizeSecrets({
        users: [
          { name: "Ada", githubToken: githubClassic },
          { name: "Grace", metadata: { password: "hidden" } }
        ]
      })
    ).toEqual({
      users: [
        { name: "Ada", githubToken: "***" },
        { name: "Grace", metadata: { password: "***" } }
      ]
    });
  });

  it("masks known token patterns inside non-secret string fields", () => {
    const input = [
      `stripe ${stripeLive}`,
      `stripe ${stripeTest}`,
      `restricted ${stripeRestricted}`,
      `github ${githubClassic}`,
      `github ${githubFineGrained}`,
      `slack ${["xoxb", "123", "abc"].join("-")}`,
      `sendgrid ${["SG", "abc", "def"].join(".")}`,
      "auth Bearer abc123"
    ].join(" | ");

    expect(sanitizeSecretString(input)).toBe(
      "stripe *** | stripe *** | restricted *** | github *** | github *** | slack *** | sendgrid *** | auth Bearer ***"
    );
  });

  it("masks cloud credentials, JWTs, private keys, package tokens, and credential URLs", () => {
    const input = [
      "AKIAIOSFODNN7EXAMPLE",
      "AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY1",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456",
      "npm_abcdefghijklmnopqrstuvwxyz123456",
      "postgres://user:password@db.example/app",
      "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----"
    ].join(" | ");
    expect(sanitizeSecretString(input)).not.toMatch(/AKIA|AIza|eyJhbGci|npm_|password@|private-material/);
  });

  it("masks fixture secrets without removing safe fields", () => {
    expect(sanitizeSecrets(secretFixture)).toEqual({
      authorization: "Bearer ***",
      nested: {
        githubToken: "***",
        note: "visible"
      }
    });
  });
});
