/**
 * @file The Stage's instruments. Each builder returns parts (src/stage/iso.ts)
 * in its own frame — footprint from (0, 0), the player's side toward +y, so
 * the default view shows every instrument from where its player sits — and
 * the map between its pressable parts and pitches.
 *
 * Part keys: `k<midi>` a piano key or a mallet bar; `d:<piece>` a drum or
 * cymbal; `s<i>f<k>` string i (0 = lowest) stopped at fret/position k;
 * `s<i>` the string itself (it rings); `bow`; `h<i>` a flute's tone hole
 * (`h<i>h` its half), `blow` the mouthpiece, `oct` the second-octave mark.
 */
export * from "./figures/common";
export * from "./figures/piano";
export * from "./figures/drums";
export * from "./figures/necks";
export * from "./figures/guitars";
export * from "./figures/bowed";
export * from "./figures/mallets";
export * from "./figures/whistle";
export * from "./figures/flute";
export * from "./figures/clarinet";
