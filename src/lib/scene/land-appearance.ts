import type * as THREE from "three";
import type { Terrain } from "@/lib/game/types";

// The land appearance contract (#641, #750; docs/design/classic-board.md "Builders and ownership"): what the island renderer needs
// of a board look. A look builds the ground and what stands on it for a set of hexes and animates it; the renderer keeps the
// tokens, pieces, picking, highlights, Bruno, the sea and the camera, and no look reaches them. Types only: this module carries
// no geometry, so it costs nothing to import.

// Full is the look as designed; lite is the ground alone, at a lower resolution, for a software GPU.
export type LandQuality = "full" | "lite";

// One hex as a look is given it: the canonical id and terrain, its axial coordinates (a look finds its coast from them), and its
// world centre. `y` is the world height of the hex's base; the look's top surface stands the block height above it, the same on
// every terrain.
export type LandHex = { readonly id: string; readonly terrain: Terrain; readonly q: number; readonly r: number; readonly x: number; readonly z: number; readonly y: number };

// What a look reports of itself: the quality it was built at, what a frame of it draws, and what it owns right now.
export type LandStats = {
  quality: LandQuality;
  drawCalls: number;
  triangles: number;
  objects: { meshes: number; geometries: number; materials: number };
};

// The camera and the tokens as one frame sees them, copied by value: a look decides from these what it may hide or shrink so a
// token's numeral stays in sight, and keeps nothing of the renderer's own objects.
export type VisibilityContext = {
  // Only the diorama view looks across the island; the others look down on it.
  view: "diorama" | "overhead" | "free";
  // The camera's world position and the orbit's azimuth (radians), as the renderer turns tokens to face it.
  camera: { x: number; y: number; z: number };
  azimuth: number;
  // Each token's world centre and the world height of its glyph's lowest row.
  tokens: readonly { x: number; y: number; z: number; glyphBottom: number }[];
};

export interface LandAppearance {
  // Only this look's ground, props and their private animation helpers.
  readonly group: THREE.Group;
  // Scene time in seconds. `all` rewrites everything; `snap` lands every transition at once and holds the decorative motion
  // still (reduced motion).
  update(t: number, all?: boolean, snap?: boolean): void;
  // The paying-hex glow on a hex this frame (the game times it); a signal only, it starts no payout.
  glow(id: string, level: number): void;
  // The roll payoff and a tap's answer; presentation only.
  roll(ids: string[]): void;
  tap(id: string): void;
  // The wayfarer's hex (or none): the ground dulls there.
  robber(id: string | null): void;
  // Something is still playing out, so the loop should draw at full rate.
  busy(): boolean;
  setVisibilityContext(context: VisibilityContext): void;
  // The world height of the ground at a point of a hex, from the hex's centre; NaN for an id this look does not have.
  groundAt(id: string, dx: number, dz: number): number;
  stats(): LandStats;
  // Releases everything this look owns; safe to call again.
  dispose(): void;
}

// Which look the board wears. The renderer holds the one that was requested and the one that is showing apart (#759): a switch
// builds the requested look off screen and swaps it in whole, so the two are equal only when the build has landed.
export type LandLook = "jelly" | "classic";

// Where the active request stands. `building` covers the import, the construction and the shader compile (`stage` says which);
// `waiting` is the pause before a retry; `failed` is out of retries until an explicit retry; `ready` is a complete look on screen.
export type LandPhase = "building" | "waiting" | "failed" | "ready";

// What the renderer says of its land, for the preference row and the proofs. A fresh immutable copy on every read.
export type LandStatus = Readonly<{
  requested: LandLook;
  // The look on screen, or null while the board's stand-in slabs stand in for it.
  displayed: LandLook | null;
  quality: LandQuality;
  phase: LandPhase;
  stage: "import" | "build" | "compile" | null;
  // Retries spent on the active request (the first attempt is not one), and the most it may spend.
  retries: number;
  maxRetries: number;
  // The last failure, cleared by a success.
  error: string | null;
}>;

// The retry policy shared with the lazy loader: the first attempt, then at most five retries four seconds apart.
export const LAND_MAX_RETRIES = 5;
export const LAND_RETRY_MS = 4000;
