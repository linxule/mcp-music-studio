// Contact sheet of a take at named marks (+ offsets in s).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FF } from "./lib.mjs";
const dir = path.resolve(process.argv[2]);
const picks = process.argv.slice(3); // e.g. tap-rest+2 eval-0+3
const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
const t0 = meta.frames[0].t * 1000;
const times = picks.map((p) => { const [m, off] = p.split("+"); const mk = meta.marks.find((x) => x.label === m); return ((mk.wall - t0) / 1000 + Number(off || 0)); });
const sel = times.map((t) => `between(t\\,${t.toFixed(3)}\\,${(t + 0.034).toFixed(3)})`).join("+");
execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", "-i", path.join(dir, "take.mp4"), "-vf", `select='${sel}',scale=270:-1,tile=${times.length}x1`, "-frames:v", "1", path.join(dir, "sheet.png")]);
console.log(times.map((t) => t.toFixed(1)).join(" "));
