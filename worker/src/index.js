const ADSB_API = "https://api.adsb.lol/v2";
const ADSB_ROUTE_API = "https://api.adsb.lol/api/0";
const FR24_API = "https://api.flightradar24.com/common/v1";
const FR24_CACHE_TTL = 120;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname.startsWith("/adsb/")) return proxyAdsb(url);
    if (url.pathname.startsWith("/route/")) return proxyRoute(url, request);
    if (url.pathname === "/geo") return handleGeo(request);
    if (url.pathname.startsWith("/schedule/")) return handleSchedule(url, request, ctx);

    return new Response("Not found", { status: 404 });
  },
};

function handleGeo(request) {
  const cf = request.cf || {};
  const lat = parseFloat(cf.latitude);
  const lng = parseFloat(cf.longitude);
  if (!isFinite(lat) || !isFinite(lng)) {
    return json(503, { error: "Approximate location unavailable" });
  }
  return json(200, {
    lat,
    lng,
    city: cf.city || "",
    region: cf.region || "",
    country: cf.country || "",
    timezone: cf.timezone || "",
    approximate: true,
    source: "ip"
  });
}

async function proxyAdsb(url) {
  const path = url.pathname.slice("/adsb".length);
  return proxy(ADSB_API + path + url.search, "GET");
}

async function proxyRoute(url, request) {
  const path = url.pathname.slice("/route".length);
  const body = request.method === "POST" ? await request.text() : null;
  return proxy(ADSB_ROUTE_API + path + url.search, request.method, body);
}

async function proxy(target, method, body) {
  try {
    const resp = await fetch(target, {
      method,
      headers: { "User-Agent": "contrails/1.0", "Content-Type": "application/json" },
      body,
    });
    const data = await resp.arrayBuffer();
    return new Response(data, {
      status: resp.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return json(502, { error: e.message });
  }
}

async function handleSchedule(url, request, ctx) {
  const iata = url.pathname.split("/").pop().toUpperCase();

  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const fr24Url =
      `${FR24_API}/airport.json?code=${encodeURIComponent(iata)}` +
      "&plugin[]=schedule&plugin[]=details&limit=100&page=1";
    const resp = await fetch(fr24Url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; contrails/1.0)" },
    });
    if (!resp.ok) throw new Error("FR24 HTTP " + resp.status);
    const raw = await resp.json();

    const plugin = raw?.result?.response?.airport?.pluginData || {};
    const sched = plugin.schedule || {};
    const detail = plugin.details || {};

    const result = {
      iata,
      name: detail.name || iata,
      arrivals: extractFlights(sched.arrivals?.data || [], "arrival"),
      departures: extractFlights(sched.departures?.data || [], "departure"),
    };

    const response = json(200, result);
    response.headers.set("Cache-Control", `s-maxage=${FR24_CACHE_TTL}`);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (e) {
    return json(502, { error: e.message });
  }
}

function extractFlights(data, direction) {
  return data.map((item) => {
    const f = item.flight || {};
    const ident = f.identification || {};
    const status = f.status || {};
    const ac = f.aircraft || {};
    const airline = f.airline || {};
    const ap = f.airport || {};
    const t = f.time || {};
    const gen = (status.generic?.status) || {};

    const entry = {
      flight: ident.number?.default || "",
      callsign: ident.callsign || "",
      airline: airline.short || airline.name || "",
      ac_code: ac.model?.code || "",
      ac_name: ac.model?.text || "",
      reg: ac.registration || "",
      status: status.text || "",
      color: gen.color || "",
      sched_dep: t.scheduled?.departure || null,
      sched_arr: t.scheduled?.arrival || null,
      est_dep: t.estimated?.departure || null,
      est_arr: t.estimated?.arrival || null,
      actual_dep: t.real?.departure || null,
      actual_arr: t.real?.arrival || null,
      live: status.live || false,
    };

    if (direction === "arrival") {
      const origin = ap.origin || {};
      entry.from_iata = origin.code?.iata || "";
      entry.from_name = origin.name || "";
    } else {
      const dest = ap.destination || {};
      entry.to_iata = dest.code?.iata || "";
      entry.to_name = dest.name || "";
    }

    return entry;
  });
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
