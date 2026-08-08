import assert from "node:assert/strict";
import test from "node:test";
import { ReportInputError, validateReport } from "../src/reports.js";

test("accepts bounded structured report payloads", () => {
  assert.doesNotThrow(() => validateReport({
    schemaVersion: 1,
    runId: "run_123",
    payload: { summary: { passed: true }, coverage: ["stripe"] }
  }));
});

test("rejects raw credentials and unbounded nested report data", () => {
  assert.throws(() => validateReport({
    schemaVersion: 1,
    runId: "run_123",
    payload: { authorization: "Bearer secret" }
  }), ReportInputError);
  assert.throws(() => validateReport({
    schemaVersion: 1,
    runId: "run_123",
    payload: { output: "sk_live_report_secret" }
  }), ReportInputError);
  assert.throws(() => validateReport({
    schemaVersion: 1,
    runId: "run_123",
    payload: { a: { b: { c: { d: { e: { f: { g: { h: { i: "too-deep" } } } } } } } } }
  }), ReportInputError);
});
