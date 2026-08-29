import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { checkEndpoint } from "../scripts/smoke-test.mjs";

test("冒烟检查报告非 2xx 服务响应", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const failure = await checkEndpoint({ name: "API", url: `http://127.0.0.1:${address.port}` });
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  assert.match(failure, /API 未就绪.*HTTP 503/);
});

test("冒烟检查报告无法连接的具体地址", async () => {
  const failure = await checkEndpoint({ name: "Web", url: "http://127.0.0.1:1/" });
  assert.match(failure, /^Web 未就绪：http:\/\/127\.0\.0\.1:1\//);
});
