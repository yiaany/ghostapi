export class BoundedRequestBodyError extends Error {
  constructor() {
    super("Request body exceeds the allowed size.");
  }
}

export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<string> {
  return new TextDecoder().decode(
    await readBoundedRequestBodyBytes(request, maxBytes),
  );
}

export async function readBoundedRequestBodyBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    throw new BoundedRequestBodyError();
  }
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BoundedRequestBodyError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function installBoundedBodyReaders(
  request: Request,
  maxBytes: number,
): void {
  let body: Promise<Uint8Array> | undefined;
  const read = () => (body ??= readBoundedRequestBodyBytes(request, maxBytes));
  const text = async () => new TextDecoder().decode(await read());

  Object.defineProperties(request, {
    text: { configurable: true, value: text },
    json: { configurable: true, value: async () => JSON.parse(await text()) },
    arrayBuffer: {
      configurable: true,
      value: async () => {
        const bytes = await read();
        return new Uint8Array(bytes).buffer;
      },
    },
    blob: {
      configurable: true,
      value: async () =>
        new Blob([new Uint8Array(await read())], {
          type: request.headers.get("content-type") ?? "",
        }),
    },
    formData: {
      configurable: true,
      value: async () =>
        new Response(new Uint8Array(await read()), {
          headers: {
            "content-type": request.headers.get("content-type") ?? "",
          },
        }).formData(),
    },
  });
}

export async function createBoundedRequest(
  request: Request,
  maxBytes: number,
): Promise<Request> {
  if (request.body === null) return request;
  const body = await readBoundedRequestBodyBytes(request, maxBytes);
  const headers = new Headers(request.headers);
  headers.set("content-length", String(body.byteLength));
  return new Request(request.url, {
    method: request.method,
    headers,
    body: new Uint8Array(body).buffer,
    redirect: request.redirect,
    signal: request.signal,
  });
}
