import { json } from "./http.js";

const PLANESPOTTERS_API = "https://api.planespotters.net/pub/photos";
const PHOTO_CACHE_TTL = 86400;
const CONTACT_USER_AGENT = "contrails/1.0 (+https://gauravdraj.github.io/contrails/)";
// Only Planespotters' own thumbnail CDN, so the URL is safe to hand to an agent verbatim.
const SAFE_PHOTO_SRC = /^https:\/\/t\.plnspttrs\.net\/[0-9]+\/[0-9A-Za-z_-]+\.jpg$/;

export async function handlePhoto(url, ctx) {
  const hex = url.pathname.split("/").pop().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return json(400, { error: "Invalid hex" });

  const cache = caches.default;
  // Canonical key: query strings and hex case must not bust the cache.
  const cacheKey = new Request("https://photo-cache/" + hex);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const resp = await fetch(`${PLANESPOTTERS_API}/hex/${hex}`, {
      headers: { "User-Agent": CONTACT_USER_AGENT },
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);

    const data = await resp.json();
    const photo = (data.photos || [])[0];
    const result = photo
      ? {
          src: (photo.thumbnail_large || photo.thumbnail || {}).src || null,
          width: (photo.thumbnail_large || photo.thumbnail || {}).size?.width || null,
          height: (photo.thumbnail_large || photo.thumbnail || {}).size?.height || null,
          link: photo.link || null,
          photographer: photo.photographer || null,
        }
      : null;

    const response = json(200, result);
    response.headers.set("Cache-Control", `s-maxage=${PHOTO_CACHE_TTL}`);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return json(502, { error: error.message });
  }
}

export async function photoFor(hex, ctx) {
  if (typeof hex !== "string" || !/^[0-9a-f]{6}$/i.test(hex)) return null;
  try {
    const response = await handlePhoto(new URL("https://photo.local/photo/" + hex), ctx);
    if (!response.ok) return null;
    const photo = await response.json();
    return photo && SAFE_PHOTO_SRC.test(photo.src || "") ? photo : null;
  } catch (_) {
    return null;
  }
}
