import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import worker from "./index.js";
import { installFixtures } from "../test-fixtures/sp-api/helpers.js";

const sdkDir = process.env.MCP_SDK_DIR;
test("official MCP SDK connects, lists tools and calls all five over HTTP", {
  skip: sdkDir ? false : "Set MCP_SDK_DIR to run official SDK conformance (SDK 1.32.2).",
}, async t => {
  // A configured but missing SDK is an installation failure, never a skip.
  const sdkUrl = path => pathToFileURL(resolve(sdkDir, "node_modules/@modelcontextprotocol/sdk/dist/esm", path)).href;
  const { Client } = await import(sdkUrl("client/index.js"));
  const { StreamableHTTPClientTransport } = await import(sdkUrl("client/streamableHttp.js"));
  const requests = [];
  let ctx;
  const server = http.createServer(async (req, res) => {
    try {
      requests.push([req.method, req.url]);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
        method: req.method, headers: req.headers, ...(body.length ? { body } : {}),
      });
      const response = await worker.fetch(request, {}, ctx);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fixture = installFixtures(t, { passLocal: origin }); ctx = fixture.ctx;
  const client = new Client({ name: "contrails-conformance", version: "1.0.0" });
  t.after(() => client.close());
  const transport = new StreamableHTTPClientTransport(new URL(origin + "/mcp"));
  await client.connect(transport);
  assert.equal(transport.sessionId, undefined);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 5);
  const args = { airport_board: { iata: "LHR" }, flight_status: { ident: "BA305", airport: "LHR" },
    planes_nearby: { lat: 51.47, lng: -0.46 }, next_big: { iata: "LHR", types: "A380,747" },
    track_flight: { ident: "BA305", airport: "LHR", eta_min: 10 } };
  for (const tool of listed.tools) {
    const result = await client.callTool({ name: tool.name, arguments: args[tool.name] });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.content[0].type, "text"); assert.ok(result.content[0].text.length <= 600);
    assert.ok(result.structuredContent);
    if (tool.name === "flight_status") assert.equal(result.structuredContent.flight, "BA305");
    if (tool.name === "track_flight") assert.ok(result.structuredContent.watch.url.startsWith(origin + "/flight/BA305/watch"));
  }
  await client.close(); await ctx.flush();
  assert.ok(requests.some(([method]) => method === "GET"), "SDK probes optional SSE with GET");
  assert.ok(requests.filter(([method]) => method === "POST").length >= 8);
});
