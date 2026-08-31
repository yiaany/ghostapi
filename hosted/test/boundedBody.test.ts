import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedRequestBodyError,
  readBoundedRequestBody,
} from "../src/boundedBody.js";

test("reads a bounded queue body without changing its signed text", async () => {
  const request = new Request(
    "https://ghostapi.invalid/internal/jobs/process-report",
    {
      method: "POST",
      headers: { "content-length": "31" },
      body: '{"schemaVersion":1,"eventId":"x"}',
    },
  );

  assert.equal(
    await readBoundedRequestBody(request, 64),
    '{"schemaVersion":1,"eventId":"x"}',
  );
});

test("rejects oversized declared and chunked queue bodies before parsing", async () => {
  const declared = new Request(
    "https://ghostapi.invalid/internal/jobs/process-report",
    {
      method: "POST",
      headers: { "content-length": "65" },
      body: "x".repeat(65),
    },
  );
  await assert.rejects(
    readBoundedRequestBody(declared, 64),
    BoundedRequestBodyError,
  );

  const chunks = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(32)));
      controller.enqueue(new TextEncoder().encode("x".repeat(33)));
      controller.close();
    },
  });
  const chunked = new Request(
    "https://ghostapi.invalid/internal/jobs/process-report",
    {
      method: "POST",
      body: chunks,
      duplex: "half",
    } as RequestInit,
  );
  await assert.rejects(
    readBoundedRequestBody(chunked, 64),
    BoundedRequestBodyError,
  );
});
