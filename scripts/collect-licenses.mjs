// Retain actual upstream license/copyright texts for the installed production
// dependency graph, including transitive packages incorporated by the bundlers.
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const seen = new Set();
const notices = [];
const missing = [];
function visit(directory) {
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (seen.has(directory)) return;
  seen.add(directory);
  if (directory !== root) {
    const files = readdirSync(directory).filter((name) => /^(licen[sc]e|copying|notice)(\.[a-z]+)?$/i.test(name));
    // Some packages put their notices in README rather than a LICENSE file.
    const texts = files.map((name) => `${name}\n${readFileSync(join(directory, name), "utf8")}`);
    // Tonal's leaf packages omit LICENSE; the monorepo's umbrella package
    // retains the MIT notice covering those modules.
    if (!texts.length && pkg.name.startsWith("@tonaljs/") && pkg.license === "MIT") {
      texts.push(readFileSync(join(root, "node_modules/tonal/LICENSE"), "utf8"));
    }
    if (!texts.length && existsSync(join(directory, "README.md"))) {
      const readme = readFileSync(join(directory, "README.md"), "utf8");
      const index = readme.search(/^#+\s+(?:License|Copyright)/im);
      if (index >= 0) texts.push(readme.slice(index));
    }
    const retained = join(root, "LICENSES", `${pkg.name.replaceAll("/", "__")}.txt`);
    if (!texts.length && existsSync(retained)) texts.push(readFileSync(retained, "utf8"));
    if (!texts.length) missing.push(`${pkg.name}@${pkg.version} (${pkg.license}) ${JSON.stringify(pkg.repository)}`);
    notices.push(`## ${pkg.name}@${pkg.version}\nLicense: ${JSON.stringify(pkg.license)}\nSource: ${JSON.stringify(pkg.repository ?? pkg.homepage ?? "see package registry")}\nGit revision: ${pkg.gitHead ?? "see lockfile and upstream package metadata"}\n\n${texts.join("\n\n")}`);
  }
  const require = createRequire(join(directory, "package.json"));
  for (const name of Object.keys(pkg.dependencies ?? {}).sort()) {
    let location;
    // Resolve by Node's module search directories so package.json export
    // restrictions and browser-only entry points do not hide license files.
    for (const base of require.resolve.paths(name) ?? []) {
      const candidate = join(base, name, "package.json");
      if (existsSync(candidate)) { location = dirname(candidate); break; }
    }
    if (!location) throw new Error(`Missing installed dependency ${name} of ${pkg.name}`);
    visit(location);
  }
}
visit(root);
if (missing.length) throw new Error(`Missing license texts; inspect before distributing:\n${missing.join("\n")}`);
writeFileSync(join(root, "dist", "THIRD_PARTY_LICENSES.txt"),
  "Installed production dependencies. See THIRD_PARTY_NOTICES.md for runtime CDN software and assets.\n\n" + notices.sort().join("\n\n----------------------------------------\n\n") + "\n");
console.log(`Retained license texts for ${notices.length} production dependencies`);
