import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";

const root = new URL(".", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");

const server = http.createServer((req, res) => {
  if (!req.url || req.url === "/" || req.url.startsWith("/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

try {
  const resp = await fetch(`http://127.0.0.1:${port}/index.html?lat=51.5074&lng=-0.1278`);
  const page = await resp.text();
  assert.match(page, /id="map"/);
  assert.match(page, /id="map-controls"/);
  assert.match(page, /contrails-core\.js/);

  // Every local script/stylesheet the page loads must exist and be precached by
  // the service worker, or installed copies boot with a missing file offline.
  const sw = await readFile(new URL("sw.js", root), "utf8");
  const assets = [...page.matchAll(/<(?:script src|link rel="stylesheet" href)="(?!https?:)([^"]+)"/g)].map((m) => m[1]);
  assert.ok(assets.length > 0, "no local assets found in index.html");
  for (const asset of assets) {
    await readFile(new URL(asset, root));
    assert.ok(sw.includes(`"./${asset}"`), `${asset} is not in sw.js CORE_ASSETS`);
  }

  const core = await readFile(new URL("js/app-core.js", root), "utf8");
  const appVersion = core.match(/const APP_VERSION = "([^"]+)"/)?.[1];
  const swVersion = sw.match(/const VERSION = "([^"]+)"/)?.[1];
  assert.ok(appVersion, "APP_VERSION not found in js/app-core.js");
  assert.equal(swVersion, appVersion, "sw.js VERSION must match APP_VERSION");
  console.log("Smoke boot check passed.");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
