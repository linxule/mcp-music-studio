# Third-party notices

Music Studio includes and uses third-party software. Their own notices and licenses
continue to apply. The build collects the installed production dependency graph's
available license texts and metadata in `dist/THIRD_PARTY_LICENSES.txt`; npm ships that file.
The exact dependency versions and integrity hashes are in `bun.lock` and
`worker/bun.lock`. Build tools and the Worker runtime dependencies are installed
separately under their respective licenses.
One upstream packaging exception is recorded in [LICENSES/chord-voicings.txt](LICENSES/chord-voicings.txt):
`chord-voicings@0.0.1` declares ISC but ships no standalone license notice.

## Original application

The original Sheet Music Server example is copyright 2025 Anthropic, PBC, under
the MIT license. Existing Music Studio MIT notices include copyright 2026 Xule Lin.
The complete original notice is preserved in [LICENSES/MIT.txt](LICENSES/MIT.txt).

## Strudel

The server integrates `@strudel/core`, `mini`, `tonal`, and `transpiler` 1.2.6;
the browser loads `@strudel/repl` 1.3.0. These are AGPL-3.0-or-later.
See [Strudel's integration guidance](https://strudel.cc/technical-manual/project-start/).

Preferred source, build scripts, dependency lockfile, and contributor notices:
[Strudel source archive at f610965f4332837febe45743105da170e8b331ed](https://codeberg.org/uzu/strudel/archive/f610965f4332837febe45743105da170e8b331ed.tar.gz).
This is the `@strudel/repl@1.3.0` tag's commit. The original JavaScript module files
for the four installed 1.2.6 packages were compared with this archive and matched;
published package manifests differ through publishing transformations.
The npm 1.2.6 metadata's gitHead is `0e26d4e741500f5bae35b023608f062a794905c2`;
it is not the same identifier as the release tag. These identifiers must not be
treated as interchangeable. When upgrading Strudel, recheck these source references.

Strudel's bundled dependencies retain the notices in that source tree and its
package manifests. This application does not modify the upstream Strudel packages.
The local adapter, validation, playback, and visual-preset integration are in `src/`.

## Other runtime software and assets

- [abcjs](https://github.com/paulrosen/abcjs): MIT; installed version recorded in the lockfile.
- [MCP SDK and Apps](https://github.com/modelcontextprotocol/ext-apps): MIT; original notices are collected with installed dependencies.
- [Hydra synth 1.4.0 source](https://github.com/ojack/hydra-synth/tree/c3ba80bd82f096e0ef7a9b7022e72c04162c25c4): AGPL-3.0; loaded on request for visual presets. This is the package's recorded source revision; its upstream source and license apply.
- [Tonal](https://github.com/tonaljs/tonal): MIT; installed version recorded in the lockfile.
- Soundfonts and sample libraries are fetched at runtime, rather than packaged as
  Music Studio's own assets. Their terms are separate from the app's license:
  [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts),
  [Strudel sample guidance](https://strudel.cc/learn/samples/), and the source
  repository for any sample URL supplied in a pattern. Soundfont choices include
  FluidR3_GM and MusyngKite; consult each collection's notices before redistribution.

This notice describes the application's dependencies; it does not claim ownership
of or impose a software license on users' music.
