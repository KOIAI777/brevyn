import assert from "node:assert/strict";
import { AgentGatewayService } from "./agent-gateway-service";

async function main(): Promise<void> {
  const service = new AgentGatewayService({ enabled: false });
  assert.deepEqual(service.getStatus(), {
    enabled: false,
    state: "disabled",
    url: undefined,
    activeRuns: 0,
    error: undefined,
  });

  const running = await service.setEnabled(true);
  assert.equal(running.enabled, true);
  assert.equal(running.state, "running");
  assert.match(running.url || "", /^http:\/\/127\.0\.0\.1:\d+$/);

  const unauthorized = await fetch(`${running.url}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(unauthorized.status, 401);

  const stopped = await service.setEnabled(false);
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.state, "disabled");
  assert.equal(stopped.url, undefined);

  await service.close();
  console.log("agent-gateway-service tests passed");
}

void main();
