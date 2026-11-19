export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };
const TEXT_HEADERS = { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" };

export function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

export function plainText(status, body) {
  return new Response(body, {
    status,
    headers: TEXT_HEADERS,
  });
}

export function jsonFromCache(cached) {
  return new Response(cached.body, {
    status: cached.status,
    headers: JSON_HEADERS,
  });
}

// Cache writes must outlive the response, so hand them to ctx.waitUntil; await
// them directly when there is no ctx (unit tests).
export async function cachePut(ctx, cache, key, response) {
  const put = Promise.resolve().then(() => cache.put(key, response)).catch(() => {});
  if (typeof ctx?.waitUntil === "function") ctx.waitUntil(put);
  else await put;
}

// Reads the body chunk by chunk and cancels the stream as soon as it passes
// maxBytes (a missing Content-Length can't be trusted). Returns null when too big.
export async function readBodyCapped(request, maxBytes) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
