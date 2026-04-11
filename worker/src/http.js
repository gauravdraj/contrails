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
