import type { App } from "@modelcontextprotocol/ext-apps";
import { SOURCE_URL } from "./source-info.js";

export function bindSourceLink(app: App): void {
  const link = document.getElementById("source-link") as HTMLAnchorElement | null;
  if (!link) return;
  link.href = SOURCE_URL;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    void app.openLink({ url: SOURCE_URL }).catch((error) => console.error("Could not open source link", error));
  });
}
