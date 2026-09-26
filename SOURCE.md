# Source and licenses

The combined Music Studio application is AGPL-3.0-or-later. See [LICENSE](LICENSE).
The pre-existing MIT grants and copyright notices remain in [LICENSES/MIT.txt](LICENSES/MIT.txt).
On 2026-09-26, the application license and source distribution were updated to account
for the integrated Strudel engine. Earlier releases retain their original notices;
this change does not revoke permissions already granted.

## Get the corresponding source

The public repository is https://github.com/linxule/mcp-music-studio.
Clean builds link to their exact Git commit from both widgets, standalone players,
and the hosted landing page. Each published version also has a `vVERSION` tag;
use its **Download ZIP** action or `git clone` followed by `git checkout vVERSION`.
The npm package contains the original TypeScript, HTML, build scripts, configuration,
Worker source, and lockfiles alongside the built output. It does not contain secrets.
For example, `npm pack mcp-music-studio@VERSION` downloads that version's package.

Upstream dependency source, licenses, and exact pinned Strudel source archives are
listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The installed dependency
license texts are collected into `dist/THIRD_PARTY_LICENSES.txt` by the build.
Dependencies are not relicensed by this application's license declaration.

## Build and run

Use Bun 1.4.2 and Node.js 24 (the versions used by CI):

```sh
bun install --frozen-lockfile
bun run build
bun run serve:stdio
```

For the hosted service, install the Worker dependencies with
`cd worker && bun install --frozen-lockfile`. Its checked-in `wrangler.jsonc`
describes the bindings. Supply your own deployment bindings; credentials and stored
user compositions are not part of the source distribution.

Release checks from a repository checkout:

```sh
bun run test
bunx playwright install chromium
bun run test:audio
bun run test:package
```

Publish the corresponding source commit before serving a build, and retain it for
as long as that build is available. A dirty build links to this document on `main`
and is for local development; do not deploy it as a public release. Rebuilding an
npm source package outside Git preserves its supplied source link.
Forks must change the repository/source URL to their own corresponding source.

The software license does not automatically apply to compositions or recordings
made with the app. Samples, soundfonts, and other third-party material can carry
their own terms; see the notices before redistributing them.
