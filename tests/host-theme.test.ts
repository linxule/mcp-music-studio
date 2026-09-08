// =============================================================================
// Host-driven theme — both widgets must honour it, not just the OS preference.
//
// Both widgets call the SDK's applyDocumentTheme(ctx.theme) on
// ui/notifications/host-context-changed. That helper only does
//
//     html.setAttribute("data-theme", theme); html.style.colorScheme = theme;
//
// and `color-scheme` does NOT move the `prefers-color-scheme` media query. So a
// stylesheet whose palette lives only under `@media (prefers-color-scheme: dark)`
// ignores the host entirely and follows the desktop instead — which is what
// strudel-app.css did until v0.5: measured in the dev harness, a host reporting
// theme "light" on a dark desktop left the Strudel chrome fully dark, and a host
// reporting "dark" on a light desktop left it fully light. mcp-app.css already
// carried the attribute blocks; this keeps the pair from drifting apart again.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

const WIDGET_CSS = ["mcp-app.css", "strudel-app.css"] as const;

describe("host-driven theme (data-theme)", () => {
  for (const file of WIDGET_CSS) {
    describe(file, () => {
      const css = read(file);

      it("defines an explicit dark palette for the host attribute", () => {
        expect(css).toMatch(/:root\[data-theme=["']dark["']\]\s*\{/);
      });

      it("defines an explicit light palette for the host attribute", () => {
        expect(css).toMatch(/:root\[data-theme=["']light["']\]\s*\{/);
      });

      it("themes the same custom properties under the attribute as under the media query", () => {
        const block = (re: RegExp) => {
          const start = re.exec(css);
          if (!start) return null;
          const from = start.index + start[0].length;
          const end = css.indexOf("}", from);
          return css.slice(from, end);
        };
        const propsIn = (text: string | null) =>
          new Set([...(text ?? "").matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

        // The dark half of `@media (prefers-color-scheme: dark) { :root { … } }`.
        const mediaIdx = css.indexOf("@media (prefers-color-scheme: dark)");
        expect(mediaIdx).toBeGreaterThan(-1);
        const mediaDark = propsIn(
          block(new RegExp("@media \\(prefers-color-scheme: dark\\)[^{]*\\{\\s*:root\\s*\\{")),
        );
        const attrDark = propsIn(block(/:root\[data-theme=["']dark["']\]\s*\{/));
        const attrLight = propsIn(block(/:root\[data-theme=["']light["']\]\s*\{/));

        expect(mediaDark.size).toBeGreaterThan(0);
        // Every token the OS-dark path themes must also be themed by the
        // host-dark path, and reset by the host-light path — otherwise a
        // host-driven switch leaves half the palette from the other mode.
        for (const prop of mediaDark) {
          expect(attrDark, `${file}: [data-theme=dark] is missing ${prop}`).toContain(prop);
          expect(attrLight, `${file}: [data-theme=light] is missing ${prop}`).toContain(prop);
        }
      });
    });
  }
});
