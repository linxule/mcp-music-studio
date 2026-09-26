import { expect, it } from "vitest";
import worker from "../worker/src/index";

it("serves the privacy policy without touching bindings", async () => {
  const response = await worker.fetch(new Request("https://example.test/privacy"), {} as never, {} as never);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  const html = await response.text();
  expect(html).toContain("Privacy policy");
  expect(html).toContain("create-share-link");
  expect(html).toContain("Context7");
});
