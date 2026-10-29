import * as THREE from "three";
import {
  CAP_LEVEL,
  DIORAMA_AZIMUTH,
  DIORAMA_POLAR,
  OVERHEAD_LEAN,
  TouchGesture,
  PICK_EDGE,
  PICK_VERTEX_RADIUS,
  chromeInsets,
  defaultView,
  fitDiorama,
  fitOrtho,
  freeMaxDistance,
  hudInsets,
  playHole,
  isSelectTap,
  pickBest,
  pickReach,
  tapSlop,
  type DioramaFit,
  type Insets,
  type OrthoFit,
  type PlayView,
  type Rect,
} from "@/lib/scene/mobile-fit";
import { readViewport } from "../viewport";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { worldOfHex } from "@/lib/game/board";
import { HEX_SIZE, SQRT3, hexCorners, hexesInRadius, vertexId } from "@/lib/game/hex";
import { LAND_MS } from "@/lib/scene/landing";
import { hashStr } from "@/lib/utils";
import { chunkUrl } from "@/lib/lazy";
import { PAINT, RIM } from "@/lib/scene/palette";
import { BLOCK_H } from "@/lib/scene/jelly-dims";
import type { JellyBoard, JellyStats } from "@/lib/scene/jelly-board";
import { LAND_MAX_RETRIES, LAND_RETRY_MS, type LandAppearance, type LandHex, type LandLook, type LandPhase, type LandQuality, type LandStatus, type VisibilityContext } from "@/lib/scene/land-appearance";
import type { Dock, Shore } from "@/lib/scene/harbor-jelly";
import { OceanLife } from "@/lib/scene/ocean-life";
import { makeBruno, type Bruno } from "@/lib/scene/bruno";
import { makeJellyOutpost, makeJellyPath, makeJellyStronghold } from "@/lib/scene/pieces-jelly";
import { CAUSTIC_GLSL, PAPER, SPLASH, addSplashRings, makeCrystalSea, makeFloorProps, makeSeaFloor, makeSplashes, makeSwell, makeWash, nearestCoast, type SeaUniforms, type WaterPath, type WaterStatus } from "@/lib/scene/crystal-water";
import { Wobble } from "@/lib/scene/wobble";
import { gainTick, play, touchHex } from "@/lib/sound";
import { payingHexes } from "@/lib/game/rules";
import { type GameState, type HarborKind, type HexCell, type Terrain, type Vertex } from "@/lib/game/types";

const TILE_Y = 0.04;

// The y of a hex's top surface: the jelly block's flat pad (the token) and its rim (the pieces) are exactly here, the same on
// every kind (docs/design/hex-jelly-prompt.md "THE BLOCK").
export function topOf(_terrain: Terrain) {
  return TILE_Y + BLOCK_H;
}

// Each look loads as its own chunk (the Hex Jelly scenes, the sculpted Classic land), by its own dynamic import: a session that
// never asks for Classic never requests it. The board shows plain slabs until the requested look is built, then the island swaps
// in whole (the owner, 2026-10-16: wait for it, no pop-in); a look change on the same land keeps the look on screen until the
// new one is ready. A failed load leaves what was there (the board still plays) and tries again a few seconds on (five times at
// most), under a fresh query: the browser remembers a module that failed for the life of the page (lazy.ts).
export type LookFactory = (hexes: LandHex[], key: string, pause: () => Promise<boolean>, lite: boolean) => Promise<LandAppearance | null>;
const failedChunk: Partial<Record<LandLook, string>> = {};
const chunkRetries: Record<LandLook, number> = { jelly: 0, classic: 0 };
const retryUrl = (look: LandLook, url: string) => `${url}?retry=${++chunkRetries[look]}`;
const importLook = async (look: LandLook): Promise<LookFactory> => {
  const url = failedChunk[look];
  try {
    if (look === "jelly") {
      const m: typeof import("@/lib/scene/jelly-board") = await (url ? import(/* @vite-ignore */ retryUrl(look, url)) : import("@/lib/scene/jelly-board"));
      return (hexes, key, pause, lite) => m.JellyBoard.create(hexes, (kind) => hashStr(`${key}|${kind}`), pause, lite);
    }
    const m: typeof import("@/lib/scene/classic-board") = await (url ? import(/* @vite-ignore */ retryUrl(look, url)) : import("@/lib/scene/classic-board"));
    return (hexes, key, pause, lite) => m.ClassicBoard.create(hexes, hashStr(`${key}|classic`), pause, lite ? "lite" : "full");
  } catch (e) {
    failedChunk[look] = chunkUrl(e) ?? failedChunk[look];
    throw e;
  }
};
// The jelly pieces (#638, pieces-jelly-prompt.md); ?pieces=slab keeps the slab pieces (for the classic look, #641).
const JELLY_PIECES = (() => {
  try {
    return new URLSearchParams(location.search).get("pieces") !== "slab";
  } catch {
    return true;
  }
})();
// How far beside a hex's token the wayfarer stands (robberSpot).
const WAYFARER_ASIDE = 0.43;
// The jelly shore is its own chunk (harbor-jelly), loaded once the hexes have swapped in.
const loadShore = () => import("@/lib/scene/harbor-jelly");
let shoreFailed = false;
// The jelly shore (docs/design/harbor-jelly-prompt.md; the owner signed it off 2026-10-16) on every full board; ?harbor=0 or
// emberisle-harbor = "plain" in storage keeps the plain beach and docks.
const HARBOR_JELLY = (() => {
  try {
    return new URLSearchParams(location.search).get("harbor") !== "0" && localStorage.getItem("emberisle-harbor") !== "plain";
  } catch {
    return true;
  }
})();
type TerrainStats = { ready: boolean; look: LandLook | null } & JellyStats;
// The stand-in slab and the unseen pick block: a hex prism the jelly block's size (corners at 30 + 60k degrees, as the
// board's pointy-top hexes), standing on its base.
const SLAB_GEO = new THREE.CylinderGeometry(HEX_SIZE * 0.98, HEX_SIZE * 0.98, BLOCK_H, 6).translate(0, BLOCK_H / 2, 0);
const PICK_MAT = new THREE.MeshBasicMaterial({ visible: false });
PICK_MAT.userData.shared = true;
const _slab = new THREE.Matrix4();
const _slabColor = new THREE.Color();
type Highlights = { vertices: string[]; edges: string[]; hexes: string[] };
// The paying-hex flash (docs/design/dice.md): the hex glows in over --duration-base, then fades linearly out by 600 ms.
const FLASH_IN_S = 0.22;
const FLASH_S = 0.6;
const FLASH_PEAK = 0.35;
// The pulse token (polish.md "Motion"): legal corners and paths breathe once per 1.2 s.
const LEGAL_PULSE_S = 1.2;

// The two views in play (docs/design/camera-light.md). Overhead: a frustum and a look-at point from the fit to the HUD hole,
// and the eye on an orbit around that point, ORBIT_RADIUS out. Diorama (the default, #597): a perspective eye on an orbit
// around the island's centre, its lens shifted onto the hole, `dist / zoom` out. Home is the fitted angle at zoom 1; a drag
// orbits, a wheel or a pinch zooms, and Home, a double tap or a double click on empty board glides back over GLIDE_MS
// (instant under reduced motion). A HUD that grows or shrinks glides the fit alone and leaves the eye where the player put it.
// The frustum keys are the overhead view's, the lens keys (`focal`, `dist`, `cx`, `cy`) the diorama's; each view leaves the
// other's at 0.
type Pose = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  tx: number;
  tz: number;
  focal: number;
  dist: number;
  cx: number;
  cy: number;
  polar: number;
  azimuth: number;
  zoom: number;
};
const FIT_KEYS: (keyof Pose)[] = ["left", "right", "top", "bottom", "tx", "tz", "focal", "dist", "cx", "cy"];
const NO_FIT = { left: 0, right: 0, top: 0, bottom: 0, tx: 0, tz: 0, focal: 0, dist: 0, cx: 0, cy: 0 };
const EYE_KEYS: (keyof Pose)[] = ["polar", "azimuth", "zoom"];
const ORBIT_RADIUS = 18;
// How far a pan may carry the look-at point from home, about the island's own radius: its centre stays on screen.
const PAN_RADIUS = 5;
const PAN_VIEW = 0.6;
// Pixels a pinch's midpoint may drift before it also pans.
const PAN_DEAD = 8;
const GATE_EVENTS = ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"] as const;
const GLIDE_MS = 280;
// Frames after a resize that measure the hole again: the HUD settles into its new layout a frame or two after the event.
const RELAYOUT_FRAMES = 4;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 32;
const _eye = new THREE.Vector3();
const _sph = new THREE.Spherical();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _n = new THREE.Vector3();
const _sea = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

// Number tokens (docs/design/tokens.md): one size in every view and at every zoom (#599, the owner: "consistent across the
// full game"), a cream disc TOKEN_R across its radius and TOKEN_H thick with a face TOKEN_FACE in radius. In the diorama view
// each turns to face the camera's azimuth and pitches TOKEN_TILT toward it, resting on its near edge.
export const TOKEN_TILT = (22 * Math.PI) / 180;
export const TOKEN_R = 0.26;
export const TOKEN_H = 0.05;
export const TOKEN_FACE = 0.245;
// How far a tilted token is lifted so its near edge stays where the flat disc's underside was.
// The drop of the lowest row of a token's glyph (its pips' bottom edge) from its face's centre, along the face.
const GLYPH_BOTTOM = ((196 + 14 - 128) / 128) * TOKEN_FACE;
export const TOKEN_LIFT = TOKEN_R * Math.sin(TOKEN_TILT) + (TOKEN_H / 2) * Math.cos(TOKEN_TILT) - TOKEN_H / 2;

type DockPosition = { id: string; kind: HarborKind; x: number; y: number };

export class IsleRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 80);
  private persp = new THREE.PerspectiveCamera(24, 1, 0.5, 160);
  // Free on the title and in the lobby; in play, the player's choice from the table menu, or with none, `defaultView` for
  // the canvas's shape (overhead on a portrait canvas, the diorama otherwise).
  view: "free" | PlayView = "free";
  private viewChoice: PlayView | null = null;
  // The diorama lens as last posed: focal length (px), fitted distance, and where its axis meets the canvas.
  private fitUpright = false;
  private lens: DioramaFit = { focal: 1, dist: 1, cx: 0, cy: 0 };
  private tokens: THREE.Object3D[] = [];
  private pending: { kind: string; id: string } | null = null;
  private downType = "mouse";
  private gesture = new TouchGesture();
  private lastTap = { t: 0, x: 0, y: 0, empty: false };
  // Set once a single pointer has moved past the tap slop; an out-and-back drag ends where it began and must not place.
  private dragged = false;
  private safeProbe: HTMLDivElement;
  private controls: OrbitControls;
  private orbit: OrbitControls;
  // The fit the play view is on, null until the view is first shown; `shownAt` is `renders` when it was switched to.
  private fit: OrthoFit | DioramaFit | null = null;
  private shownAt = -1;
  private glide: { from: Pose; to: Pose; keys: (keyof Pose)[]; start: number } | null = null;
  // The hole is re-measured on the next frame after a view or state change (React has committed the HUD by then), never on
  // HUD housekeeping alone (a timed notice leaving, the Place chip): the camera moves with the game, and an idle board idles.
  private refitDue = false;
  private relayout = 0;
  private sizeW = 0;
  private sizeH = 0;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private land = new THREE.Group();
  private pieces = new THREE.Group();
  private marks = new THREE.Group();
  private living = new THREE.Group();
  private pickables: THREE.Object3D[] = [];
  private composer!: EffectComposer;
  private ssao!: SSAOPass;
  private renderPass!: RenderPass;
  private wayfarer: THREE.Group;
  // The wayfarer's figure (bruno.ts): his idle peeking and his scurry.
  private bruno: Bruno;
  private oceanLife = new OceanLife();
  // Touch the sea (crystal-water.md): the live splashes, the tiles giving under a tap, and where a drag on the water last stirred.
  private splash = makeSplashes();
  private wobble = new Wobble();
  private trail: { x: number; z: number; t: number } | null = null;
  private boats: THREE.Group[] = [];
  // Each dock as buildLand found it, its plain pier, and the jelly shore once it swaps in.
  private docks: Dock[] = [];
  private piers: THREE.Mesh[] = [];
  private shore: Shore | null = null;
  private beach!: THREE.Mesh;
  // The crystal sea's own lace, kept while a shore's moved one stands in for it.
  private baseWash: THREE.Mesh | null = null;
  // The island's land look (Hex Jelly, jelly-board.ts, or the sculpted Classic land, classic-board.ts), once built; until then
  // `slabs` stand in. `lookOn` is which one this is; `want` is the one asked for (#759), and the two differ only while the
  // asked-for look builds or after it failed. Everything else on the board (pick blocks, tokens, pieces, the wayfarer, the shore,
  // the sea, the camera) is the renderer's own and is never rebuilt by a look change.
  private look: LandAppearance | null = null;
  private lookOn: LandLook | null = null;
  private want: LandLook = "jelly";
  // The active request's progress. `buildId` names the request (a look change, a new board, a retry, a dispose each end the one
  // before): every wait in it rechecks that it still owns the board.
  private buildId = 0;
  private landPhase: LandPhase = "building";
  private landStage: LandStatus["stage"] = null;
  private landRetries = 0;
  private landError: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private landSpec: { key: string; hexes: LandHex[] } | null = null;
  private shoreGen = -1;
  private visFor: LandAppearance | null = null;
  private visKey = "";
  // Hooks the proofs wrap to delay or fail a stage; the production ones import the chunk and compile its shaders.
  loadLook: (look: LandLook) => Promise<LookFactory> = importLook;
  compileLook: (look: LandAppearance) => Promise<void> = (look) => this.compileInPlace(look);
  retryMs = LAND_RETRY_MS;
  // Called with the new status whenever it changes (the preference row reads it).
  onLand: (status: LandStatus) => void = () => {};
  // Whether the GPU is software, and whether the board is lite (the ground only).
  software = false;
  lite = false;
  private slabs: THREE.InstancedMesh | null = null;
  private landGen = 0;
  // The scenes' clock as last advanced (they hold at it under reduced motion).
  private jellyT = 0;
  private lastLand: string | null = null;
  private lastSeq = -1;
  private lastState: GameState | null = null;
  private lastHi: Highlights = { vertices: [], edges: [], hexes: [] };
  private lastInteractive = false;
  // #438: each piece on the board by key ("e:<edge>" / "v:<vertex>") and its kind, and when the ones still landing were
  // placed (performance.now()), so a rebuild mid-fall carries the fall over to the new mesh instead of restarting it.
  private placed = new Map<string, PieceKind>();
  private landStart = new Map<string, number>();
  private landings: { obj: THREE.Object3D; kind: PieceKind; start: number; restY: number }[] = [];
  private legalIds = new Set<string>();
  // An armed Upgrade: only the player's own outposts are legal, so a touch tap on one raises it at once, with no Place chip.
  private oneTap = false;
  // A build is armed (#667): a tap on a hex is aimed at a placement, so it makes no touch sound.
  private armed = false;
  private down = { x: 0, y: 0 };
  private stopped = false;
  private robberTarget = new THREE.Vector3();
  private walk: { from: THREE.Vector3; to: THREE.Vector3; start: number; hops: number; dur: number } | null = null;
  private lantern: THREE.MeshStandardMaterial;
  // Each land hex's glow by hex id (its level read as `emissiveIntensity`, as when it was the cap's), and the flashes under
  // way (age in seconds, advanced by the frame's dt). The jelly board warms each hex by its level.
  caps = new Map<string, { emissiveIntensity: number }>();
  private payingPieces: { key: string; age: number; delay: number; sounded: boolean }[] = [];
  private flashes: { mat: { emissiveIntensity: number }; id: string; age: number }[] = [];
  private clock = new THREE.Timer();
  private water = makeWater();
  // The crystal sea, or the simple shader when the GPU cannot render to a float target, the one-time probe finds it slow, or
  // the player chose Simple in the table menu (crystal-water.md). Reported through `onWater`.
  // Every load starts simple; only a saved Crystal choice or a passed probe switches it (software GL stays cheap while a
  // reloaded page rejoins its table).
  waterPath: WaterPath = "simple";
  onWater: (w: WaterStatus) => void = () => {};
  // The play view now shown, for the table menu's View row.
  onView: (v: PlayView) => void = () => {};
  onDocks: (docks: DockPosition[]) => void = () => {};
  onDock: (id: string) => boolean = () => false;
  private dockPositions: DockPosition[] = [];
  private docksDirty = true;
  private choice: WaterPath | null = null;
  private waterSet = false;
  private probed: { path: WaterPath; ms: number } | null = null;
  private probe: { stage: WaterPath; frames: number; ms: number } | null = null;
  private crystalOk = false;
  private motion = { value: 1 };
  // The sea's shared clock, motion and paper fade (inner and outer radius), for the crystal sea, its floor and the simple sea.
  private sea!: SeaUniforms;
  // The scene without the crystal sea, colour and depth, drawn each crystal frame for the sea to refract and absorb.
  // Allocated on the first crystal frame.
  private under: THREE.WebGLRenderTarget | null = null;
  private opaqueSea!: THREE.Mesh;
  // The crystal sea, its edge strip, the floor and its props, and the CPU wave field: built on the first switch to crystal,
  // so a page on the simple sea does no more at boot than before the crystal sea existed.
  private coast!: ReturnType<typeof coastLoop>;
  private crystal: { group: THREE.Group; sea: THREE.Mesh; wash: THREE.Mesh; swell: ReturnType<typeof makeSwell> } | null = null;
  // The probe waits for a settled client (setSettled), then a second with no pointer on the canvas.
  private settledAt = 0;
  private lastPointer = 0;
  private titleMode = false;
  private lastFrame = 0;
  // Until when the loop runs at full rate: a drag, a camera move, a walk or a state change holds it there for 1 s (#331).
  private busyUntil = 0;
  private lastMarks = "";
  private wasCalm = false;
  // prefers-reduced-motion (#382): nothing ambient moves, and the loop draws only on a change.
  private calmMq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  // Frames drawn; the idle proof counts them.
  renders = 0;
  private foam!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private coastMiter = new Map<string, { mx: number; mz: number }>();
  private coastOrder: string[] = [];
  private onPick: (kind: "hex" | "vertex" | "edge", id: string) => void;
  private onSelect: (sel: { kind: "hex" | "vertex" | "edge"; id: string } | null) => void;

  constructor(
    canvas: HTMLCanvasElement,
    onPick: (kind: "hex" | "vertex" | "edge", id: string) => void,
    onSelect: (sel: { kind: "hex" | "vertex" | "edge"; id: string } | null) => void = () => {},
  ) {
    this.onPick = onPick;
    this.onSelect = onSelect;
    this.safeProbe = document.createElement("div");
    this.safeProbe.style.cssText =
      "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.appendChild(this.safeProbe);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    // Frame cost tracks pixels (#310). The crystal sea runs at up to 2 everywhere (every player's phone is an iPhone Pro class
    // GPU); `applyWater` keeps 1.5 on a phone for the simple sea (2.25x the pixels of 1, against 4x at 2).
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.coarse() ? 1.5 : 2));
    this.renderer.setClearColor(PAPER, 1);
    // A software GPU (SwiftShader, llvmpipe: CI, and machines with no GPU) builds the lite board (jelly-board.ts): there the
    // drawing shares the CPU with the page, and the full scenes' build and frames starve it. `emberisle-jelly` in storage
    // ("full" or "lite") overrides either way; the proofs of the scenes themselves ask for full.
    {
      const gl = this.renderer.getContext();
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      this.software = /swiftshader|llvmpipe|softpipe|software/i.test(String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)));
      let saved: string | null = null;
      try {
        saved = localStorage.getItem("emberisle-jelly");
      } catch {
        // Storage blocked: the default.
      }
      this.lite = saved === "full" ? false : saved === "lite" ? true : this.software;
      // One line the owner can read off a phone's console: which board, and why.
      console.info(`Emberisle board: ${this.lite ? "lite (the jelly ground)" : "full Hex Jelly scenes"}${saved ? ` (emberisle-jelly=${saved})` : this.software ? " (software GPU)" : ""}`);
    }
    // A lost context takes its fences with it: drop ours, or ambient frames would wait on it for good.
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    // `?fps` on the page's address: a small overlay of the frame's cost (frame interval, the draw's CPU time, the GPU's lag
    // behind it by fence), draw calls and triangles, for reading numbers off a phone.
    if (new URLSearchParams(location.search).has("fps")) this.fps = makeFps(this.renderer);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 80);
    this.camera.position.set(6.6, 9.1, 7.4);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 18;
    this.controls.maxPolarAngle = 1.02;
    this.controls.minPolarAngle = 0.7;
    this.controls.target.set(0.15, 0.05, 0);
    this.controls.autoRotateSpeed = 0.28;
    this.calmMq?.addEventListener("change", this.onCalm);
    this.controls.addEventListener("start", this.wake);
    this.controls.addEventListener("change", this.onCameraChange);
    this.orbit = new OrbitControls(this.ortho, canvas);
    this.orbit.enabled = false;
    // No damping: the board stops where the pointer stops, and nothing drifts after a glide home.
    this.orbit.enableDamping = false;
    // Two fingers (or the right button) pan along the ground; the target stays at cap level and within PAN_RADIUS of home.
    this.orbit.screenSpacePanning = false;
    this.orbit.minZoom = 0.8;
    this.orbit.maxZoom = 2.4;
    this.orbit.minPolarAngle = 0.12;
    this.orbit.maxPolarAngle = 1.15;
    this.orbit.addEventListener("start", this.wake);
    this.orbit.addEventListener("change", this.onCameraChange);

    this.scene.fog = new THREE.Fog(PAPER, 26, 52);
    // A lit board on a table (polish.md "The board look target", #135): one warm key lamp carries the light, so the
    // slabs shade on their sides and every prop casts a soft shadow; the sky and ground bounce are low and nearly grey,
    // so the caps' own paint is the colour on screen. No flat ambient: that was what washed the caps out.
    this.scene.add(new THREE.HemisphereLight(0xe9e4da, 0xc8ad86, 0.55));
    const sun = new THREE.DirectionalLight(0xffe3bd, 2.1);
    sun.position.set(8, 16, 6);
    sun.castShadow = true;
    // 1024 over 18 units, blurred 6 texels: shadow edges soften over about a tenth of a hex, like a lamp, not the noon sun.
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.radius = 6;
    sun.shadow.camera.left = -9;
    sun.shadow.camera.right = 9;
    sun.shadow.camera.top = 9;
    sun.shadow.camera.bottom = -9;
    sun.shadow.bias = -0.0003;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xd9e4ea, 0.3);
    fill.position.set(-8, 8, -4);
    this.scene.add(fill);

    // Water, beach, and foam (docs/design/ocean.md). Built once: the outline does not change when the isle is dealt.
    this.opaqueSea = new THREE.Mesh(new THREE.CircleGeometry(48, 64), this.water);
    this.opaqueSea.rotation.x = -Math.PI / 2;
    this.opaqueSea.position.y = -0.02;
    this.scene.add(this.opaqueSea);
    this.scene.add(this.oceanLife.group, this.oceanLife.fish);

    const coast = (this.coast = coastLoop());
    this.sea = { uTime: this.water.uniforms.uTime!, uMotion: this.motion, uFade: { value: new THREE.Vector2(11, 22) }, ...this.splash.uniforms };
    this.water.uniforms.uFade = this.sea.uFade;
    addSplashRings(this.water, this.sea);
    // The crystal sea refracts a half-float copy of the scene.
    const ext = this.renderer.extensions;
    this.crystalOk = this.renderer.capabilities.isWebGL2 && (ext.has("EXT_color_buffer_float") || ext.has("EXT_color_buffer_half_float"));
    for (const c of coast) this.coastMiter.set(c.id, { mx: c.mx, mz: c.mz });
    this.coastOrder = coast.map((c) => c.id);
    const beach = (this.beach = new THREE.Mesh(
      coastStrip(coast, -0.04, 0.22),
      new THREE.MeshStandardMaterial({ color: 0xe8d7b0, roughness: 1, metalness: 0 }),
    ));
    beach.position.y = 0.015;
    beach.receiveShadow = true;
    this.scene.add(beach);

    this.foam = new THREE.Mesh(
      coastStrip(coast, 0.22, 0.42),
      new THREE.MeshBasicMaterial({ color: 0xe8f8f8, transparent: true, opacity: 0.32, depthWrite: false }),
    );
    this.foam.position.y = 0.028;
    this.scene.add(this.foam);

    this.bruno = makeBruno();
    this.wayfarer = this.bruno.g;
    this.lantern = this.bruno.lantern;
    this.living.add(this.wayfarer);
    this.scene.add(this.land, this.living, this.pieces, this.marks);

    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointercancel", this.onCancel);
    // Capture phase on the shell, so the pinch gate sees a move before the orbit controls do.
    for (const t of GATE_EVENTS) canvas.parentElement?.addEventListener(t, this.gate, true);
    // OrbitControls' private pan step; the gate holds a pinch's midpoint still. If a three.js upgrade drops it, pinch just pans a little.
    const oc = this.orbit as unknown as { _pan?: (x: number, y: number) => void };
    const pan = oc._pan?.bind(this.orbit);
    if (pan) oc._pan = (x, y) => this.panOpen && pan(x, y);
    window.addEventListener("resize", this.resize);
    // A phone's bars sliding in or out move the visual viewport without always firing a window resize.
    window.visualViewport?.addEventListener("resize", this.onViewport);
    window.addEventListener("keydown", this.onKey);
    // Focus moving into or out of the chrome (the keyboard PlaceList shows while focused) changes the hole.
    canvas.parentElement?.addEventListener("focusin", this.remeasure);
    canvas.parentElement?.addEventListener("focusout", this.remeasure);
    this.resize();
    this.clock.connect(document);
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.ssao = new SSAOPass(this.scene, this.camera, 1, 1);
    this.ssao.kernelRadius = 10;
    this.ssao.minDistance = 0.001;
    this.ssao.maxDistance = 0.08;
    this.composer.addPass(this.ssao);
    this.composer.addPass(new OutputPass());
    this.renderer.setAnimationLoop(this.tick);
  }

  // Off the table (title and lobby) the island is a backdrop under a card: the slow orbit, no SSAO, 30 frames a second.
  // In play it is the board fitted to the HUD hole, which the player may orbit and zoom and snap home again.
  setTitleMode(v: boolean) {
    if (v !== this.titleMode) this.onCameraChange();
    this.titleMode = v;
    if (v) this.clearPayers();
    this.ssao.enabled = !v && !this.play();
    this.setView(v ? "free" : this.playView());
  }

  // The player's view in play, from the table menu: the tilted diorama (the default) or the overhead board.
  setPlayView(v: PlayView | null) {
    this.viewChoice = v;
    if (this.play()) this.setView(this.playView());
  }

  private playView(): PlayView {
    const c = this.renderer.domElement;
    return this.viewChoice ?? defaultView(c.clientWidth || 1, c.clientHeight || 1, readViewport().phone);
  }

  private play() {
    return this.view !== "free";
  }

  private cam(): THREE.Camera {
    return this.view === "overhead" ? this.ortho : this.view === "diorama" ? this.persp : this.camera;
  }

  private coarse() {
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  }

  private calm() {
    return this.calmMq?.matches ?? false;
  }

  // The preference flipped: draw the island as it stands now. The event comes a frame after `matches` changes, so tick reads that.
  private onCalm = () => this.wake();

  private safe(withKeyboard = true): Insets {
    const cs = getComputedStyle(this.safeProbe);
    const viewport = window.visualViewport;
    // A focused phone field can bring a keyboard over a canvas whose CSS height has not changed.
    const typing = withKeyboard && this.coarse() && document.activeElement?.matches("input, textarea") && viewport && Math.abs(viewport.scale - 1) < 0.01;
    const keyboard = typing ? Math.max(0, this.renderer.domElement.clientHeight - viewport.height - viewport.offsetTop) : 0;
    return {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: Math.max(parseFloat(cs.paddingBottom) || 0, keyboard),
      left: parseFloat(cs.paddingLeft) || 0,
    };
  }

  // The hole the HUD leaves for the island right now, measured from the chrome around the canvas. Proofs read it too.
  insets(): Insets {
    const c = this.renderer.domElement;
    // The keyboard is an overlay like the chat above it: only the notch counts.
    return playHole(c.clientWidth, c.clientHeight, readViewport().phone, this.safe(false));
  }

  // What the chrome around the canvas leaves right now, overlays and all: for proofs, never for the fit.
  liveInsets(): Insets {
    const c = this.renderer.domElement;
    const shell = c.parentElement;
    return chromeInsets(c.clientWidth, c.clientHeight, shell ? solidRects(shell, c) : [], this.safe());
  }

  // Overhead is one orthographic camera fitted to the HUD hole and diorama one perspective camera fitted to it, sharing one
  // orbit; Free is the title's view.
  setView(view: "free" | PlayView) {
    if (view === this.view) return;
    this.wake();
    this.view = view;
    if (view !== "free") this.onView(view);
    const play = this.play();
    this.controls.enabled = !play;
    this.orbit.enabled = play;
    this.orbit.object = view === "diorama" ? this.persp : this.ortho;
    // The diorama's dolly limits (applyPose) would clamp the overhead eye's orbit radius; overhead zooms by the frustum.
    if (view !== "diorama") [this.orbit.minDistance, this.orbit.maxDistance] = [0, Infinity];
    this.ssao.enabled = !play && !this.titleMode;
    const cam = this.cam();
    this.renderPass.camera = cam;
    this.ssao.camera = cam;
    // Each entry to the table starts from home.
    this.fit = null;
    this.glide = null;
    this.shownAt = this.renders;
    this.refitDue = true;
    this.resize();
  }

  // While a stronghold is armed, a touch tap on a legal outpost builds at once (no Place chip).
  setOneTap(on: boolean) {
    this.oneTap = on;
  }

  setArmed(on: boolean) {
    this.armed = on;
  }

  // The mark a coarse pointer has selected, waiting for the Place chip. Pulses it and locks orbit meanwhile.
  setPending(p: { kind: string; id: string } | null) {
    if (p?.id !== this.pending?.id) this.wake();
    this.pending = p;
    this.controls.enableRotate = !p;
    this.orbit.enableRotate = !p;
    for (const o of this.marks.children) {
      const m = o as THREE.Mesh;
      const mat = m.material as THREE.MeshStandardMaterial | undefined;
      if (m.userData?.id && mat && "emissiveIntensity" in mat) mat.emissiveIntensity = m.userData.id === p?.id ? 1.4 : (m.userData.baseGlow as number);
    }
  }

  // Glow the hexes that paid: each warms and fades back, once, while its scene does the roll payoff's jelly squash and
  // ripple (not under reduced motion).
  flashHexes(ids: string[]) {
    for (const id of ids) {
      const mat = this.caps.get(id);
      if (!mat) continue;
      this.flashes = this.flashes.filter((f) => f.mat !== mat);
      this.flashes.push({ mat, id, age: 0 });
    }
    if (!this.calm()) this.look?.roll(ids);
  }

  // The caps' emissive for each flash at its age. Reduced motion steps to the peak and back with no ramp.
  private stepFlashes(dt: number, calm: boolean) {
    if (!this.flashes.length) return;
    for (const f of this.flashes) {
      f.age += dt;
      const a = f.age;
      const level = a >= FLASH_S ? 0 : calm ? 1 : a < FLASH_IN_S ? 1 - (1 - a / FLASH_IN_S) ** 3 : 1 - (a - FLASH_IN_S) / (FLASH_S - FLASH_IN_S);
      f.mat.emissiveIntensity = FLASH_PEAK * level;
      this.look?.glow(f.id, f.mat.emissiveIntensity);
    }
    this.flashes = this.flashes.filter((f) => f.age < FLASH_S);
  }

  // Canonical grants identify the actual paying corner, including coalesced builds before/after the roll.
  // Older saved grants have no vertex identity: keep those silent rather than guessing a neighbour.
  private pulsePayers(state: GameState) {
    const paid = new Set((state.lastProduction ?? []).map((g) => g.vertex));
    const ordered = state.players.flatMap((p) => state.vertices.filter((v) => paid.has(v.id) && v.building?.playerId === p.id));
    this.payingPieces = ordered.map((v, i) => ({ key: `v:${v.id}`, age: 0, delay: i * 0.09, sounded: false }));
  }

  private clearPayers() {
    for (const p of this.payingPieces) { p.age = Infinity; p.sounded = true; }
    this.stepPayers(0, true);
  }

  private stepPayers(dt: number, calm: boolean) {
    const duration = calm ? 1.2 : 0.28;
    for (const p of this.payingPieces) {
      p.age += dt;
      const age = p.age - p.delay;
      const obj = this.pieces.children.find((o) => o.userData.key === p.key);
      if (!obj || age < 0) continue;
      if (!p.sounded) {
        p.sounded = true;
        if (p.delay < 0.72) gainTick();
      }
      const active = age < duration;
      obj.scale.setScalar(calm || !active ? 1 : 1 + 0.12 * snapBezier(age < 0.14 ? age / 0.14 : (0.28 - age) / 0.14));
      // Jelly pieces share their base material. Clone before warming one so its non-paying neighbours stay untouched.
      obj.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!(mesh.material instanceof THREE.MeshStandardMaterial)) return;
        if (calm && active && !mesh.userData.payerMaterial) {
          mesh.material = mesh.material.clone();
          mesh.material.userData.shared = false;
          mesh.userData.payerMaterial = true;
        }
        if (mesh.userData.payerMaterial) {
          const mat = mesh.material as THREE.MeshStandardMaterial;
          mat.emissive.set(0xffd27a);
          mat.emissiveIntensity = calm && active ? 0.35 : 0;
        }
      });
    }
    this.payingPieces = this.payingPieces.filter((p) => p.age - p.delay < duration);
  }

  setBoard(state: GameState, highlights: Highlights, interactive: boolean) {
    // Only a roll seen live flashes: the same island and exactly one more dice roll than last time. Landing on a state that
    // already has rolls (a spectator, a rejoin, the title's island carried into a game) does not; several actions in one push
    // (online bots) still flash when one roll is among them.
    const prev = this.lastState;
    const rolled = prev && landKey(prev) === landKey(state) && (state.rolls ?? 0) === (prev.rolls ?? 0) + 1;
    this.lastState = state;
    this.lastHi = highlights;
    this.lastInteractive = interactive;
    // Online clients get no seed until the game ends (#111), so a new island is spotted by what buildLand draws.
    const land = landKey(state);
    const landChanged = this.lastLand !== land;
    // The store calls this on every change, chat and timers included; only what the island draws wakes the loop.
    const marks = `${interactive}|${highlights.vertices}|${highlights.edges}|${highlights.hexes}`;
    if (landChanged || this.lastSeq !== state.seq || marks !== this.lastMarks) this.wake();
    // A new state or an armed build (the marks change with the phase bar) re-measures the hole on the next frame.
    if (landChanged || this.lastSeq !== state.seq || marks !== this.lastMarks) this.refitDue = true;
    this.lastMarks = marks;
    if (landChanged) {
      this.buildLand(state);
      this.lastLand = land;
    }
    if (this.lastSeq !== state.seq) {
      this.buildPieces(state, landChanged || this.lastSeq === -1);
      this.lastSeq = state.seq;
    }
    this.buildMarks(state, highlights, interactive);
    if (landChanged) this.payingPieces = [];
    if (rolled) {
      this.flashHexes(payingHexes(state));
      this.pulsePayers(state);
    }
    this.look?.robber(state.robberHex ?? null);
    const rh = state.hexes.find((h) => h.id === state.robberHex);
    if (rh) {
      this.robberSpot(rh);
      if (!this.wayfarer.userData.placed || landChanged) {
        this.walk = null;
        this.wayfarer.position.copy(this.robberTarget);
        this.wayfarer.userData.placed = true;
      } else if (!this.walk) this.startWalk();
    }
  }

  // Where the wayfarer stands on a hex: on the waste (no token) its centre; on a hex with a number, beside the token, to its
  // left as the camera looks (0.43 out, past the token's 0.26 and his base), on the scene's own ground there, so the numeral
  // and its pips stay in sight (tokens-prove checks his figure as an occluder).
  private robberSpot(rh: HexCell) {
    const w = worldOfHex(rh);
    if (rh.pip === null) return this.robberTarget.set(w.x, topOf(rh.terrain), w.z);
    const [dx, dz] = [-Math.cos(DIORAMA_AZIMUTH) * WAYFARER_ASIDE, Math.sin(DIORAMA_AZIMUTH) * WAYFARER_ASIDE];
    const g = this.look?.groundAt(rh.id, dx, dz);
    return this.robberTarget.set(w.x + dx, g !== undefined && Number.isFinite(g) ? g : topOf(rh.terrain), w.z + dz);
  }

  // One 0.3-high hop per hex of distance, 300 ms each, 900 ms at most.
  private startWalk() {
    const from = this.wayfarer.position;
    const dist = Math.hypot(this.robberTarget.x - from.x, this.robberTarget.z - from.z);
    if (dist <= 0.01) return;
    if (this.calm()) {
      // Reduced motion: he turns and is simply there (#382).
      this.wayfarer.lookAt(this.robberTarget.x, from.y, this.robberTarget.z);
      this.wayfarer.position.copy(this.robberTarget);
      return;
    }
    const hops = Math.max(1, Math.round(dist / (HEX_SIZE * SQRT3)));
    // The clock is only as fresh as the last drawn frame, up to 83 ms old while idle; add the time since, so the hop starts at 0.
    const start = this.clock.getElapsed() + (performance.now() - this.lastFrame) / 1000;
    this.walk = { from: from.clone(), to: this.robberTarget.clone(), start, hops, dur: Math.min(0.9, 0.3 * hops) };
  }

  // Where a hex, corner, or edge id sits on screen, in page pixels. For the chat proof, which checks nothing covers a target.
  screenOf(id: string): { x: number; y: number } | null {
    const st = this.lastState;
    if (!st) return null;
    const tops = hexTops(st);
    const vmap = new Map(st.vertices.map((v) => [v.id, v]));
    const p = new THREE.Vector3();
    const v = vmap.get(id);
    const e = st.edges.find((x) => x.id === id);
    const h = st.hexes.find((x) => x.id === id);
    if (v) p.set(v.x, vertexTop(tops, v), v.z);
    else if (e) {
      const a = vmap.get(e.va)!;
      const b = vmap.get(e.vb)!;
      p.set((a.x + b.x) / 2, edgeTop(tops, a, b), (a.z + b.z) / 2);
    } else if (h) {
      const w = worldOfHex(h);
      p.set(w.x, topOf(h.terrain), w.z);
    } else return null;
    return this.screenAt(p.x, p.y, p.z);
  }

  // Where a world point sits on screen, in page pixels, through the camera in use. Proofs read it too.
  screenAt(x: number, y: number, z: number): { x: number; y: number } {
    const p = _p.set(x, y, z).project(this.cam());
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }

  // CSS px per world unit at a point, across the screen: a token's or a piece's size there. Proofs read it.
  pxPerUnit(x: number, y: number, z: number): number {
    const cam = this.cam();
    cam.updateMatrixWorld();
    const a = this.screenAt(x, y, z);
    _q.setFromMatrixColumn(cam.matrixWorld, 0);
    const b = this.screenAt(x + _q.x, y + _q.y, z + _q.z);
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  dispose() {
    this.clearPayers();
    this.stopped = true;
    this.renderer.domElement.removeEventListener("webglcontextlost", this.onContextLost);
    this.dropFence();
    this.fps?.el.remove();
    this.buildId++;
    clearTimeout(this.retryTimer);
    this.look?.dispose();
    this.look = null;
    this.lookOn = null;
    this.shore?.dispose();
    this.shore = null;
    this.renderer.setAnimationLoop(null);
    this.controls.dispose();
    this.orbit.dispose();
    this.calmMq?.removeEventListener("change", this.onCalm);
    window.removeEventListener("resize", this.resize);
    window.visualViewport?.removeEventListener("resize", this.onViewport);
    window.removeEventListener("keydown", this.onKey);
    this.renderer.domElement.parentElement?.removeEventListener("focusin", this.remeasure);
    this.renderer.domElement.parentElement?.removeEventListener("focusout", this.remeasure);
    for (const t of GATE_EVENTS) this.renderer.domElement.parentElement?.removeEventListener(t, this.gate, true);
    this.renderer.domElement.removeEventListener("pointerdown", this.onDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onUp);
    this.renderer.domElement.removeEventListener("pointermove", this.onMove);
    this.renderer.domElement.removeEventListener("pointercancel", this.onCancel);
    this.safeProbe.remove();
    this.oceanLife.dispose();
    this.bruno.dispose();
    this.under?.dispose();
    this.renderer.dispose();
  }

  private wake = () => {
    this.busyUntil = performance.now() + 1000;
  };

  private onCameraChange = () => {
    this.docksDirty = true;
    this.wake();
  };

  // The visual viewport also moves with the keyboard and a pinch, which leave the canvas as it is: only the hole is measured then.
  private onViewport = () => {
    this.docksDirty = true;
    const c = this.renderer.domElement;
    if ((c.clientWidth || 1) !== this.sizeW || (c.clientHeight || 1) !== this.sizeH) return this.resize();
    this.remeasure();
    this.relayout = RELAYOUT_FRAMES;
  };

  private resize = () => {
    this.onCameraChange();
    const c = this.renderer.domElement;
    const w = (this.sizeW = c.clientWidth || 1);
    const h = (this.sizeH = c.clientHeight || 1);
    // A phone turned upright or on its side changes the default view (setView resizes again, in the new view).
    if (this.play() && this.view !== this.playView()) return this.setView(this.playView());
    this.camera.aspect = w / h;
    // Dolly limit: OrbitControls.update() clamps the current distance to the new max on the next frame.
    this.controls.maxDistance = freeMaxDistance(h, hudInsets(w, h, this.coarse(), this.safe()), this.coarse());
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    const ratio = this.renderer.getPixelRatio();
    this.under?.setSize(Math.round(w * ratio), Math.round(h * ratio));
    this.ssao?.setSize(w, h);
    this.refit(true);
    // The HUD re-lays out for the new size after this event (a rotation swaps its columns and rails), so the hole just
    // measured is the old one: measure again on each of the next frames.
    this.relayout = RELAYOUT_FRAMES;
  };

  // The player changed the chrome without the game moving (opened the chat or a sheet, focused the PlaceList): measure the
  // hole again on the next frame. Cheap enough to call on every such change; a hole that did not change refits nothing.
  remeasure = () => {
    this.refitDue = true;
  };

  // Fit the play view to the hole the HUD leaves now. The first fit of a view lands at home; a later change of hole
  // (the phase bar grew with the state) glides the frustum and the look-at point and keeps the eye the player set.
  private refit(instant: boolean) {
    this.refitDue = false;
    if (!this.play()) return;
    const c = this.renderer.domElement;
    const base = this.insets();
    // The hole's edges on the shell, so the HUD can centre a moment on the island (TurnMoment): the one the map is fitted to.
    for (const k of ["top", "right", "bottom", "left"] as const) c.parentElement?.style.setProperty(`--hole-${k}`, `${base[k]}px`);
    const [w, h] = [c.clientWidth || 1, c.clientHeight || 1];
    const f = this.view === "diorama" ? fitDiorama(w, h, base) : fitOrtho(w, h, base, OVERHEAD_LEAN);
    const was = this.fit;
    if (was && FIT_KEYS.every((k) => Math.abs(this.fitPose(f)[k] - this.fitPose(was)[k]) < 1e-6)) return;
    this.fit = f;
    const upright = h > w;
    const carry = upright === this.fitUpright;
    this.fitUpright = upright;
    if (!was) {
      this.applyPose(this.fitPose(f));
      this.orbit.update();
      return;
    }
    // The pan survives any refit but a turn of the phone (a view toggle starts from home anyway): a Safari toolbar or a
    // keyboard resizing the canvas keeps the player's offset from home.
    const to = this.fitPose(f);
    if (carry) {
      const from = this.fitPose(was);
      to.tx += this.orbit.target.x - from.tx;
      to.tz += this.orbit.target.z - from.tz;
    }
    this.moveTo(to, FIT_KEYS, instant || this.renders <= this.shownAt);
  }

  private fitPose(f: OrthoFit | DioramaFit): Pose {
    if ("focal" in f) return { ...NO_FIT, focal: f.focal, dist: f.dist, cx: f.cx, cy: f.cy, polar: DIORAMA_POLAR, azimuth: DIORAMA_AZIMUTH, zoom: 1 };
    return { ...NO_FIT, left: f.left, right: f.right, top: f.top, bottom: f.bottom, tx: f.x, tz: f.z, polar: OVERHEAD_LEAN, azimuth: 0, zoom: 1 };
  }

  // Read from the camera itself, so it is right straight after applyPose, before the controls' next update.
  private pose(): Pose {
    const cam = this.view === "diorama" ? this.persp : this.ortho;
    _sph.setFromVector3(_eye.copy(cam.position).sub(this.orbit.target));
    const eye = { polar: _sph.phi, azimuth: _sph.theta };
    if (this.view === "diorama") return { ...NO_FIT, ...this.lens, tx: this.orbit.target.x, tz: this.orbit.target.z, ...eye, zoom: this.lens.dist / _sph.radius };
    const o = this.ortho;
    return { ...NO_FIT, left: o.left, right: o.right, top: o.top, bottom: o.bottom, tx: this.orbit.target.x, tz: this.orbit.target.z, ...eye, zoom: o.zoom };
  }

  // Overhead: leaned toward the player (+Z is screen-down), looking at cap level over the hole's centre. Diorama: looking at
  // cap level over the island's centre, the lens axis meeting the canvas at (cx, cy), so the island sits in the hole.
  private applyPose(p: Pose) {
    this.docksDirty = true;
    if (this.view === "diorama") {
      const c = this.persp;
      const [w, h] = [this.sizeW || 1, this.sizeH || 1];
      // A frame centred on the lens axis that holds the canvas, and the canvas as a view into it.
      const fullW = 2 * Math.max(p.cx, w - p.cx, 1);
      const fullH = 2 * Math.max(p.cy, h - p.cy, 1);
      c.fov = (2 * Math.atan(fullH / 2 / p.focal) * 180) / Math.PI;
      c.aspect = fullW / fullH;
      c.setViewOffset(fullW, fullH, fullW / 2 - p.cx, fullH / 2 - p.cy, w, h);
      this.lens = { focal: p.focal, dist: p.dist, cx: p.cx, cy: p.cy };
      this.orbit.minDistance = p.dist / this.orbit.maxZoom;
      this.orbit.maxDistance = p.dist / this.orbit.minZoom;
      this.orbit.target.set(p.tx, CAP_LEVEL, p.tz);
      // The lens frame is wider than the canvas, so a pan step in pixels is scaled to match the finger.
      this.orbit.panSpeed = h / fullH;
      c.up.set(0, 1, 0);
      c.position.setFromSphericalCoords(p.dist / p.zoom, p.polar, p.azimuth).add(this.orbit.target);
      c.lookAt(this.orbit.target);
      c.updateProjectionMatrix();
      return;
    }
    const o = this.ortho;
    o.left = p.left;
    o.right = p.right;
    o.top = p.top;
    o.bottom = p.bottom;
    o.zoom = p.zoom;
    this.orbit.target.set(p.tx, CAP_LEVEL, p.tz);
    this.orbit.panSpeed = 1;
    o.up.set(0, 1, 0);
    o.position.setFromSphericalCoords(ORBIT_RADIUS, p.polar, p.azimuth).add(this.orbit.target);
    o.lookAt(this.orbit.target);
    o.updateProjectionMatrix();
  }

  // The wake's 1 s hold covers the glide; nothing re-arms it frame by frame, so the loop idles again right after.
  private moveTo(to: Pose, keys: (keyof Pose)[], instant: boolean) {
    this.wake();
    if (instant || this.calm()) {
      const p = this.pose();
      for (const k of keys) p[k] = to[k];
      this.applyPose(p);
      this.glide = null;
      return;
    }
    this.glide = { from: this.pose(), to, keys, start: performance.now() };
  }

  // Each frame of a glide: the eased mix of the keys on the move, the rest as they are now (a drag mid-glide still orbits).
  private stepGlide(now: number) {
    const g = this.glide;
    if (!g) return;
    const u = this.calm() ? 1 : Math.min(1, (now - g.start) / GLIDE_MS);
    const e = 1 - (1 - u) ** 3;
    const p = this.pose();
    for (const k of g.keys) {
      let d = g.to[k] - g.from[k];
      // The short way round.
      if (k === "azimuth") d = Math.atan2(Math.sin(d), Math.cos(d));
      p[k] = g.from[k] + d * e;
    }
    this.applyPose(p);
    if (u >= 1) this.glide = null;
  }

  // The legal marks a ray passes near, in the diorama view: a corner or a path within `pickReach` of the ray where it passes
  // (a far one is smaller on screen, so its reach in world units is larger), nearest miss on screen first; hexes as the ray meets them.
  private reachHits(coarse: boolean) {
    const ray = this.raycaster.ray;
    const hits: { kind: "hex" | "vertex" | "edge"; id: string; distance: number }[] = [];
    for (const o of this.pickables) {
      const { kind, id } = o.userData as { kind: "hex" | "vertex" | "edge"; id: string };
      if (!id || kind === "hex") continue;
      let miss: number;
      if (kind === "vertex") {
        miss = ray.distanceToPoint(o.position);
        ray.closestPointToPoint(o.position, _q);
      } else {
        const half = ((o as THREE.Mesh<THREE.BoxGeometry>).geometry.parameters.depth / 2);
        _n.set(Math.sin(o.rotation.y), 0, Math.cos(o.rotation.y)).multiplyScalar(half);
        miss = Math.sqrt(ray.distanceSqToSegment(_p.copy(o.position).sub(_n), _eye.copy(o.position).add(_n), _q));
      }
      const depth = _q.sub(this.persp.position).dot(this.persp.getWorldDirection(_n));
      // Ranked by the miss on screen, so a near mark and a far one compare in what the finger sees.
      if (miss <= pickReach(depth, this.lens.focal, coarse, kind === "edge" ? PICK_EDGE.w / 2 : PICK_VERTEX_RADIUS)) hits.push({ kind, id, distance: (miss * this.lens.focal) / depth });
    }
    for (const h of this.raycaster.intersectObjects(this.pickables.filter((o) => o.userData.kind === "hex"), true)) {
      if (h.object.userData.id) hits.push({ kind: "hex", id: h.object.userData.id as string, distance: h.distance });
    }
    return hits;
  }

  // How far the token on a hex is lifted off the cap: tilted in the diorama view, it rests on its near edge.
  private liftOf(hexId: string) {
    return (this.tokens.find((t) => t.userData.hex === hexId)?.userData.lift as number | undefined) ?? 0;
  }

  // Tokens face the diorama camera (TOKEN_TILT toward it, turned to its azimuth); in the other views they lie flat. Always
  // their own size. The wayfarer keeps standing on his.
  private poseTokens() {
    const diorama = this.view === "diorama";
    const az = diorama ? this.orbit.getAzimuthalAngle() : 0;
    const lift = diorama ? TOKEN_LIFT : 0;
    for (const t of this.tokens) {
      t.rotation.set(diorama ? TOKEN_TILT : 0, az, 0, "YXZ");
      t.position.y = (t.userData.restY as number) + lift;
      t.userData.lift = lift;
    }
  }

  // How far a pan may carry the look-at point from home: about the island's radius, and no more than PAN_VIEW of the shorter
  // half of what the canvas shows at the fitted zoom, so a short landscape canvas cannot carry the island off its edge. It
  // does not shrink as the player zooms in: that is when they want to reach the edge tiles.
  panLimit(): number {
    const f = this.fit;
    if (!f) return 0;
    const half = "focal" in f ? (f.dist * Math.min(this.sizeW, this.sizeH)) / 2 / f.focal : Math.min(f.right - f.left, f.top - f.bottom) / 2;
    return Math.min(PAN_RADIUS, PAN_VIEW * half);
  }

  // The eye moves with the target, so the view does not lag a frame.
  private clampPan() {
    if (!this.fit) return;
    const home = this.fitPose(this.fit);
    const t = this.orbit.target;
    const cam = this.orbit.object;
    const max = this.panLimit();
    const dx = t.x - home.tx;
    const dz = t.z - home.tz;
    const d = Math.hypot(dx, dz);
    if (d <= max) return;
    this.docksDirty = true;
    const k = max / d - 1;
    t.x += dx * k;
    t.z += dz * k;
    cam.position.x += dx * k;
    cam.position.z += dz * k;
  }

  // Back to the fitted view, zoom 1, over the hole's centre.
  goHome() {
    if (!this.play() || !this.fit) return;
    this.moveTo(this.fitPose(this.fit), [...FIT_KEYS, ...EYE_KEYS], false);
  }

  // A drag mid-glide takes the eye (a tap does not: the controls fire "start" on every press); the fit keeps gliding.
  private dragTakesEye() {
    if (!this.glide) return;
    this.glide.keys = this.glide.keys.filter((k) => !EYE_KEYS.includes(k));
    if (!this.glide.keys.length) this.glide = null;
  }

  // Two fingers mid-glide take the look-at point and the zoom; the fit's frustum and lens keep gliding.
  private fingersTakeFit() {
    if (!this.glide) return;
    this.glide.keys = this.glide.keys.filter((k) => k !== "tx" && k !== "tz" && k !== "zoom");
    if (!this.glide.keys.length) this.glide = null;
  }

  // Home snaps the view unless the key means something where it landed: a text field, a dialog, a scrolling region (the
  // chat log, the bottom stack), a modifier chord, or a handler that already took it.
  private onKey = (e: KeyboardEvent) => {
    if (e.key !== "Home" || !this.play() || this.titleMode) return;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (t?.closest("[role=dialog], [role=alertdialog]") || inScroller(t)) return;
    e.preventDefault();
    this.goHome();
  };

  // Two fingers pan and pinch together; a pinch pans only once its midpoint has moved PAN_DEAD px from where the second finger landed.
  private fingers = new Map<number, { x: number; y: number }>();
  private panOpen = true;
  private pinchStart: { mx: number; my: number } | null = null;
  private gate = (e: PointerEvent) => {
    const f = this.fingers;
    if (e.type === "pointermove") {
      if (!f.has(e.pointerId)) return;
      f.set(e.pointerId, { x: e.clientX, y: e.clientY });
    } else {
      if (e.type === "pointerdown") {
        if (e.target !== this.renderer.domElement) return;
        f.set(e.pointerId, { x: e.clientX, y: e.clientY });
      } else f.delete(e.pointerId);
      this.pinchStart = null;
      this.panOpen = f.size < 2;
    }
    if (f.size !== 2 || this.panOpen) return;
    const [a, b] = [...f.values()];
    const cur = { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    const st = (this.pinchStart ??= cur);
    this.panOpen = Math.hypot(cur.mx - st.mx, cur.my - st.my) >= PAN_DEAD;
  };

  private onDown = (e: PointerEvent) => {
    this.lastPointer = performance.now();
    this.wake();
    this.down.x = e.clientX;
    this.down.y = e.clientY;
    this.downType = e.pointerType;
    this.dragged = false;
    this.gesture.down(e.pointerId, e.clientX, e.clientY);
    this.poke(e);
  };

  // The orbit controls own the drag and the pinch; this keeps the finger count and whether the pointer ever left the tap.
  private onMove = (e: PointerEvent) => {
    if (!this.gesture.pointers.has(e.pointerId)) return;
    this.gesture.move(e.pointerId, e.clientX, e.clientY);
    this.lastPointer = performance.now();
    this.wake();
    if (this.gesture.pointers.size === 2) this.fingersTakeFit();
    if (this.dragged || this.gesture.pointers.size !== 1) return;
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > tapSlop(this.downType, this.coarse())) {
      this.dragged = true;
      // A drag orbits the camera: the stir ends where the tap slop does, so an orbit never splashes.
      this.trail = null;
      this.dragTakesEye();
      return;
    }
    if (this.trail) this.stir(e);
  };

  private onCancel = (e: PointerEvent) => {
    this.trail = null;
    this.gesture.up(e.pointerId);
  };

  private onUp = (e: PointerEvent) => {
    this.trail = null;
    if (this.gesture.up(e.pointerId) || this.dragged) return;
    const coarse = this.coarse();
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > tapSlop(this.downType, coarse)) return;
    if (e.button === 0) {
      let nearest: DockPosition | undefined;
      let distance = Infinity;
      for (const dock of this.dockPositions) {
        const dx = e.clientX - dock.x;
        const dy = e.clientY - dock.y;
        const d = dx * dx + dy * dy;
        if (Math.abs(dx) <= 22 && Math.abs(dy) <= 22 && d < distance) {
          nearest = dock;
          distance = d;
        }
      }
      if (nearest && this.onDock(nearest.id)) {
        this.lastTap.t = 0;
        return;
      }
    }
    const hit = pickBest(this.hitsAt(e, coarse || this.downType === "touch"));
    const legal = hit !== undefined && this.legalIds.has(hit.id);
    // Two taps on empty board (nothing legal under either) within DOUBLE_TAP_MS and DOUBLE_TAP_PX snap the view home.
    const now = performance.now();
    const again = now - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) <= DOUBLE_TAP_PX;
    if (this.play() && !legal && again && this.lastTap.empty) {
      this.lastTap.t = 0;
      if (this.pending) this.onSelect(null);
      this.goHome();
      return;
    }
    this.lastTap = { t: now, x: e.clientX, y: e.clientY, empty: !legal };
    // #667: a plain tap on a hex that places nothing (no drag or pinch got here; nothing armed, nothing legal to place) sounds its terrain.
    if (hit?.kind === "hex" && !this.armed && !this.pending && this.legalIds.size === 0 && !this.titleMode) {
      const terrain = this.lastState?.hexes.find((h) => h.id === hit.id)?.terrain;
      if (terrain) touchHex(terrain);
    }
    const touch = coarse || this.downType === "touch";
    if (!touch) {
      if (hit) this.onPick(hit.kind, hit.id);
      return;
    }
    if (!hit || !legal) {
      if (this.pending) this.onSelect(null);
      return;
    }
    if (!this.oneTap && isSelectTap(coarse, this.downType, this.pending?.id ?? null, hit.id)) this.onSelect({ kind: hit.kind, id: hit.id });
    else this.onPick(hit.kind, hit.id);
  };

  // What a press at this pointer would pick: every hex, corner and path target under it (the ray is left set for seaPoint).
  private hitsAt(e: PointerEvent, coarse: boolean) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.cam());
    return this.view === "diorama" ? this.reachHits(coarse) : this.raycaster
      .intersectObjects(this.pickables, true)
      .filter((h) => h.object.userData.id)
      .map((h) => ({ kind: h.object.userData.kind as "hex" | "vertex" | "edge", id: h.object.userData.id as string, distance: h.distance }));
  }

  // Where the last ray meets the sea, if that is open water and not the beach.
  private seaPoint() {
    const p = this.raycaster.ray.intersectPlane(_sea, _p);
    if (!p) return null;
    const c = nearestCoast(this.coast, p.x, p.z);
    return c.offshore && c.o >= SPLASH.minOffset ? { x: p.x, z: p.z } : null;
  }

  // Touch the sea (crystal-water.md): on the press, not the release. A press on a tile wobbles it; one that picks no target at
  // all splashes the water under it. A corner or a path under the finger takes the press for the game: nothing here.
  private poke(e: PointerEvent) {
    this.trail = null;
    if (e.button !== 0 || this.gesture.pointers.size !== 1) return;
    const hit = pickBest(this.hitsAt(e, this.coarse() || e.pointerType === "touch"));
    if (hit) {
      if (hit.kind === "hex") this.wobbleHex(hit.id);
      return;
    }
    const p = this.seaPoint();
    if (!p) return;
    this.splashAt(p.x, p.z, 1);
    this.trail = { ...p, t: performance.now() };
  }

  // A finger moved on the water within the tap slop stirs a short trail of small ripples.
  private stir(e: PointerEvent) {
    const now = performance.now();
    if (!this.trail || now - this.trail.t < 80) return;
    this.hitsAt(e, false);
    const p = this.seaPoint();
    if (!p || Math.hypot(p.x - this.trail.x, p.z - this.trail.z) < 0.35) return;
    this.splashAt(p.x, p.z, 0.45);
    this.trail = { ...p, t: now };
  }

  /** A splash on the sea at (x, z), 1 for a tap. Starts at once; the fish and the visitor near it scatter. */
  splashAt(x: number, z: number, strength: number) {
    this.splash.add(x, z, strength, this.clock.getElapsed() + (performance.now() - this.lastFrame) / 1000);
    if (!this.calm()) this.oceanLife.scatter(x, z);
    // A tap plops (sound.ts keeps it quiet while muted); a drag's trail does not.
    if (strength >= 1) play("plop");
    this.busyUntil = Math.max(this.busyUntil, performance.now() + SPLASH.life * 1000);
  }

  /** The tapped tile and its scene give a little jelly wobble, and its token with them; never under reduced motion or while a
   *  piece is landing. */
  wobbleHex(id: string) {
    if (this.calm() || this.landings.length) return;
    const parts = this.land.children.filter((o) => o.userData.hex === id);
    this.wobble.start(id, parts, TILE_Y, performance.now());
    this.look?.tap(id);
    this.wake();
  }

  // The legal marks breathe between 0.6x and 1.2x of their base glow on the 1.2 s pulse token, one shared phase (#437).
  // Reduced motion holds the base glow. The wayfarer's hex ring keeps its own faster pulse. Marks pulse at the idle 12 fps by design.
  private pulseMarks(t: number, still: boolean) {
    const k = still ? 1 : 0.9 + 0.3 * Math.sin((t * 2 * Math.PI) / LEGAL_PULSE_S);
    for (const m of this.marks.children) {
      const base = m.userData.baseGlow as number | undefined;
      if (base === undefined || m.userData.id === this.pending?.id) continue;
      const mat = (m as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material;
      mat.emissiveIntensity = m.userData.kind === "hex" ? (still ? base : 0.5 + 0.35 * (0.5 + 0.5 * Math.sin(t * 4))) : base * k;
    }
  }

  private tick = () => {
    if (this.stopped || document.hidden) return;
    const now = performance.now();
    // Title: 30 fps. On the board with nothing moving: 12 fps, enough to keep the water, sheep and boats alive (#331).
    const pulsing = this.marks.children.some((m) => m.userData.kind === "hex" && m.userData.id !== this.pending?.id);
    // Reduced motion (#382): no tick at all; a drag, a camera move or a state push still draws for its 1 s hold.
    const calm = this.calm();
    // Reading `matches` here can swallow the change event, so a flip seen on this frame wakes the loop itself.
    if (calm !== this.wasCalm) {
      this.wasCalm = calm;
      this.wake();
    }
    this.stepLandings(now, calm);
    if (this.relayout > 0) {
      this.relayout--;
      this.refitDue = true;
    }
    if (this.refitDue) this.refit(false);
    if (calm && this.walk) {
      this.walk = null;
      this.startWalk();
    }
    const busy = now < this.busyUntil || this.flashes.length > 0 || this.payingPieces.length > 0 || !!this.look?.busy();
    const gap = calm ? (busy ? 0 : Infinity) : this.titleMode ? 1000 / 30 : this.walk || pulsing || busy ? 0 : 1000 / 12;
    if (now - this.lastFrame < gap - 2) return;
    // Backpressure on ambient frames (the title's turn, the idle sea): while the GPU is still on the last one, wait for it
    // rather than queue another. A GPU that keeps up has always finished; a software one (CI, no GPU) would otherwise block
    // the page in its GL calls, frame after frame, and starve input and every other tab. A frame a change or an interaction
    // asked for (busy), and every frame under reduced motion, goes at once.
    if (!busy && !calm && this.gpuBehind()) return;
    this.lastFrame = now;
    this.clock.update();
    const t = this.clock.getElapsed();
    // An idle frame is 83 ms apart; a smaller cap would slow the sheep while idle.
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.stepFlashes(dt, calm);
    this.stepPayers(dt, calm);
    this.controls.autoRotate = this.titleMode && !calm;
    if (this.play()) {
      this.orbit.update();
      this.clampPan();
      this.stepGlide(now);
    } else {
      this.controls.enableDamping = !calm;
      this.controls.update();
    }
    // Reduced motion: a flat, still sea; only the foam lace stays.
    this.motion.value = calm ? 0 : 1;
    this.splash.step(t);
    if (calm) {
      this.oceanLife.step(0, false, this.oceanViewport);
      // The scenes hold still; a dulling or a glow still lands.
      this.look?.update(this.jellyT, false, true);
      this.shore?.update(this.jellyT);
      this.pulseMarks(0, true);
      this.draw();
      return;
    }
    this.water.uniforms.uTime!.value = t;
    const swell = this.waterPath === "crystal" ? this.crystal?.swell : undefined;
    this.oceanLife.step(dt, true, this.oceanViewport, swell ? (x, z) => swell(x, z, t).y : undefined);
    this.foam.material.opacity = 0.32 + 0.23 * (0.5 + 0.5 * Math.sin(t * 0.8));
    this.jellyT = t;
    this.look?.update(t);
    this.shore?.update(t);
    if (this.walk) {
      const w = this.walk;
      const u = Math.min(1, (t - w.start) / w.dur);
      const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
      this.wayfarer.position.lerpVectors(w.from, w.to, e);
      this.wayfarer.position.y += 0.3 * Math.abs(Math.sin(Math.PI * u * w.hops));
      this.wayfarer.lookAt(w.to.x, this.wayfarer.position.y, w.to.z);
      if (u >= 1) {
        this.wake();
        this.walk = null;
        this.startWalk();
      }
    }
    this.lantern.emissiveIntensity = 1.6 + 0.3 * Math.sin(t * 2.2);
    this.bruno.update(t, !!this.walk);
    this.pulseMarks(t, false);
    for (const b of this.boats) {
      if (!swell) {
        b.position.y = 0.06 + Math.sin(t * 1.6 + b.position.x) * 0.04;
        b.rotation.z = Math.sin(t * 1.35 + b.position.z) * 0.07;
        b.rotation.x = Math.sin(t * 1.1) * 0.035;
        continue;
      }
      // Ride the same waves the sea draws: lift with the height, pitch and roll with the slope under the hull.
      const sea = swell(b.position.x, b.position.z, t);
      const yaw = b.rotation.y;
      b.position.y = 0.07 + sea.y;
      b.rotation.x = -Math.atan(sea.gx * Math.sin(yaw) + sea.gz * Math.cos(yaw));
      b.rotation.z = Math.atan(sea.gx * Math.cos(yaw) - sea.gz * Math.sin(yaw));
    }
    this.wobble.step(now);
    this.draw();
  };

  // In the overhead view the sea fills the canvas: the fade to paper starts 1.5x past the farthest visible point. In the free
  // view the far horizon reaches the paper; in the diorama the paper starts past the water the hole shows, and the fog
  // starts past the island however far the eye has backed off.
  private fadeSea() {
    const fade = this.sea.uFade.value;
    const fog = this.scene.fog as THREE.Fog;
    const diorama = this.view === "diorama";
    fog.near = diorama ? this.persp.position.distanceTo(this.orbit.target) + 8 : 26;
    fog.far = fog.near + 26;
    if (diorama) return fade.set(16, 30);
    if (!this.play()) return fade.set(11, 22);
    const o = this.ortho;
    const halfW = (o.right - o.left) / 2 / o.zoom;
    const halfH = (o.top - o.bottom) / 2 / o.zoom / Math.max(0.3, Math.cos(this.orbit.getPolarAngle()));
    const far = Math.hypot(halfW, halfH) + Math.hypot(this.orbit.target.x, this.orbit.target.z);
    fade.set(Math.min(40, far * 1.5), Math.min(47, far * 1.5 + 10));
  }

  // The scene under the crystal sea, without it and its edge strip, into `under`.
  private drawUnder(c: NonNullable<IsleRenderer["crystal"]>) {
    const cam = this.cam() as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const r = this.renderer;
    if (!this.under) {
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      this.under = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(size.x, size.y) });
    }
    c.sea.visible = c.wash.visible = false;
    r.setRenderTarget(this.under);
    try {
      r.render(this.scene, cam);
    } finally {
      // A throw mid-render must not leave the target bound or the sea hidden for every later frame.
      r.setRenderTarget(null);
      c.sea.visible = c.wash.visible = true;
    }
    const u = (c.sea.material as THREE.ShaderMaterial).uniforms;
    u.uUnder!.value = this.under.texture;
    u.uUnderDepth!.value = this.under.depthTexture;
    u.uResolution!.value.set(this.under.width, this.under.height);
    u.uNear!.value = cam.near;
    u.uFar!.value = cam.far;
  }

  // The client is settled (on the title with nothing dialling, or in play with its first state), so the probe may run: never
  // during boot, a restore or a rejoin, when a slow GPU's measured frames would hold up the socket.
  setSettled(v: boolean) {
    if (!v) this.settledAt = 0;
    else if (!this.settledAt) this.settledAt = performance.now();
  }

  // The player's saved choice from the table menu, or null to let the probe decide. Switching swaps the sea in place.
  setWaterChoice(choice: WaterPath | null) {
    if (choice === this.choice && this.waterSet) return;
    this.waterSet = true;
    this.choice = choice;
    // The probe runs once, when nothing has chosen for it: first on the simple sea, then (if that is quick) on the crystal one.
    this.probe = !choice && !this.probed && this.crystalOk ? { stage: "simple", frames: 0, ms: 0 } : null;
    this.applyWater();
  }

  private applyWater() {
    const path: WaterPath = !this.crystalOk ? "simple" : (this.choice ?? this.probed?.path ?? this.probe?.stage ?? "simple");
    this.waterPath = path;
    if (path === "crystal" && !this.crystal) {
      const sea = makeCrystalSea(this.coast, this.sea);
      const wash = makeWash(this.coast, this.sea);
      const group = new THREE.Group();
      group.add(sea, wash, makeSeaFloor(this.coast, this.sea), makeFloorProps(this.coast));
      this.scene.add(group);
      this.crystal = { group, sea, wash, swell: makeSwell(this.coast, this.splash) };
      this.baseWash = wash;
    }
    if (this.crystal) this.crystal.group.visible = path === "crystal";
    // The crystal sea's edge strip draws its own thin lace.
    this.opaqueSea.visible = this.foam.visible = path === "simple";
    const ratio = Math.min(window.devicePixelRatio, path === "simple" && this.coarse() ? 1.5 : 2);
    // The first call at boot is usually the simple sea at the ratio the constructor set: no second resize then.
    if (ratio !== this.renderer.getPixelRatio()) {
      this.renderer.setPixelRatio(ratio);
      this.composer.setPixelRatio(ratio);
      this.resize();
    } else this.wake();
    this.onWater({ path, source: this.choice ? "saved" : "probe", ms: this.probed?.ms ?? null });
  }

  // Dock targets follow camera and canvas changes; ambient frames leave their cached positions alone.
  private updateDockPositions() {
    if (this.titleMode || !this.docksDirty) return;
    this.docksDirty = false;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const camera = this.cam();
    const docks = this.docks.map((d) => {
      const p = _p.set(d.cx + d.mx * 0.62, 0.12, d.cz + d.mz * 0.62).project(camera);
      return {
        id: d.vids.join(":"),
        kind: d.kind,
        x: rect.left + ((p.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - p.y) / 2) * rect.height,
      };
    });
    if (docks.length !== this.dockPositions.length || docks.some((d, i) => {
      const previous = this.dockPositions[i]!;
      return d.id !== previous.id || d.kind !== previous.kind || Math.round(d.x) !== Math.round(previous.x) || Math.round(d.y) !== Math.round(previous.y);
    })) {
      this.dockPositions = docks;
      this.onDocks(docks);
    }
  }

  // The one-time GPU check, on a built and warm scene of a settled client (a second after setSettled and after the last
  // pointer on the canvas), each frame made to finish by a 1-pixel read. First up to 10 simple frames after 5 warm ones: over 11 ms on average (the crystal sea draws the scene twice), the sea
  // stays simple and the crystal one is never drawn. Otherwise up to 10 crystal frames after 3 warm ones: over 22 ms, back to
  // simple. A stage stops as soon as its frames pass its 10-frame budget, so a slow GPU stalls for one frame.
  private draw() {
    const t0 = performance.now();
    this.poseTokens();
    this.pushVisibility();
    this.fadeSea();
    const crystal = this.waterPath === "crystal" ? this.crystal : null;
    if (crystal) this.drawUnder(crystal);
    // The under pass already drew this frame's shadow map.
    this.renderer.shadowMap.autoUpdate = !crystal;
    try {
      this.fps?.begin(t0);
      this.composer.render();
      this.fenceFrame();
      this.fps?.end(this.look?.stats() ?? null, this.lite);
    } finally {
      this.renderer.shadowMap.autoUpdate = true;
    }
    this.renders += 1;
    this.updateDockPositions();
    const p = this.probe;
    const warm = p?.stage === "simple" ? 5 : 3;
    const budget = p?.stage === "simple" ? 11 : 22;
    const now = performance.now();
    const settled = this.settledAt > 0 && now - this.settledAt > 1000 && now - this.lastPointer > 1000;
    if (!p || p.stage !== this.waterPath || !this.lastState || !settled || ++p.frames <= warm) return;
    const gl = this.renderer.getContext();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    p.ms += performance.now() - t0;
    const n = p.frames - warm;
    if (n < 10 && p.ms <= budget * 10) return;
    const ms = Math.round((p.ms / n) * 10) / 10;
    if (p.stage === "simple" && ms <= budget) this.probe = { stage: "crystal", frames: 0, ms: 0 };
    else {
      this.probe = null;
      this.probed = { path: p.stage === "crystal" && ms <= budget ? "crystal" : "simple", ms };
    }
    this.applyWater();
  }

  // The fence the last frame left, and whether the GPU is still behind it.
  private fence: WebGLSync | null = null;
  private fps: Fps | null = null;
  private dropFence() {
    const gl = this.renderer.getContext();
    if (this.fence && gl instanceof WebGL2RenderingContext && !gl.isContextLost()) gl.deleteSync(this.fence);
    this.fence = null;
  }
  private onContextLost = () => {
    this.fence = null;
  };
  private fenceFrame() {
    const gl = this.renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext) || this.fence) return;
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }
  private gpuBehind() {
    const gl = this.renderer.getContext();
    if (!this.fence || !(gl instanceof WebGL2RenderingContext)) return false;
    if (gl.getSyncParameter(this.fence, gl.SYNC_STATUS) !== gl.SIGNALED) return true;
    gl.deleteSync(this.fence);
    this.fence = null;
    this.fps?.gpu(performance.now());
    return false;
  }

  // Compute the visible water once when choosing a visit, not on every animal frame.
  private oceanViewport = () => {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const inset = this.insets();
    const camera = this.cam();
    const scale = this.view === "overhead" ? width * this.ortho.zoom / (this.ortho.right - this.ortho.left) : this.view === "diorama" ? this.pxPerUnit(0, CAP_LEVEL, 0) : 28;
    const point = new THREE.Vector3();
    return (x: number, z: number, reach: number) => {
      point.set(x, 0.12, z).project(camera);
      const px = (point.x + 1) * width / 2, py = (1 - point.y) * height / 2;
      const margin = 8 + reach * scale;
      return point.z > -1 && point.z < 1 && px > inset.left + margin && px < width - inset.right - margin && py > inset.top + margin && py < height - inset.bottom - margin;
    };
  };

  // The land look (#599, #759): its draw calls and triangles in the main pass, read by board-look-prove through
  // `window.__terrain`; before it is built, the stand-in slabs.
  terrainStats(): TerrainStats {
    const l = this.look;
    if (l) {
      const s: Partial<JellyStats> & ReturnType<LandAppearance["stats"]> = l.stats();
      return { ready: true, look: this.lookOn, lite: s.quality === "lite", drawCalls: s.drawCalls, triangles: s.triangles, kinds: s.kinds ?? 0, batches: s.batches ?? 0, bakes: s.bakes ?? 0, sprites: s.sprites ?? 0 };
    }
    const n = this.slabs?.count ?? 0;
    return { ready: false, look: null, lite: this.lite, drawCalls: n ? 1 : 0, triangles: n * 24, kinds: 0, batches: 0, bakes: 0, sprites: 0 };
  }

  // Ready once the island's land look is built and showing (the proofs wait on it).
  get landReady() {
    return this.look !== null;
  }

  // The jelly board, for the proofs (its ground and clearance); null while another look, or the slabs, is showing.
  get jellyBoard() {
    return this.lookOn === "jelly" ? (this.look as JellyBoard) : null;
  }

  // The land look on screen, whichever it is, for the proofs (stats, ground, the group).
  get landLook(): LandAppearance | null {
    return this.look;
  }

  // The selection and status API (#759) the preference row reads: which look is asked for, which shows, and how the build
  // stands. A fresh frozen copy each time.
  landStatus(): LandStatus {
    return Object.freeze({
      requested: this.want,
      displayed: this.lookOn,
      quality: (this.look?.stats().quality ?? (this.lite ? "lite" : "full")) as LandQuality,
      phase: this.landPhase,
      stage: this.landStage,
      retries: this.landRetries,
      maxRetries: LAND_MAX_RETRIES,
      error: this.landError,
    });
  }

  // Ask for a look. The one on screen stays until the new one is built, compiled and ready to swap in whole; asking again, for
  // the same or another look, ends the request before it. Nothing here touches the stored choice.
  setLandLook(look: LandLook) {
    if (look === this.want) return;
    this.want = look;
    this.requestLook();
  }

  // Explicit recovery: after a failure (or while one waits to retry) try the requested look again, with the retries renewed.
  retryLand() {
    if (this.landPhase === "failed" || this.landPhase === "waiting") this.requestLook();
  }

  private announce() {
    try {
      this.onLand(this.landStatus());
    } catch {
      // A listener's failure is its own.
    }
  }

  // Start the request for the wanted look on the board as it stands: nothing to build if it is already showing.
  private requestLook() {
    clearTimeout(this.retryTimer);
    const id = ++this.buildId;
    this.landRetries = 0;
    this.landError = null;
    this.landStage = null;
    if (this.look && this.lookOn === this.want) this.landPhase = "ready";
    else {
      this.landPhase = "building";
      if (this.landSpec) void this.growLook(id, this.want, this.landSpec, 0);
    }
    this.announce();
  }

  private stage(id: number, stage: LandStatus["stage"]) {
    if (id !== this.buildId) return;
    this.landStage = stage;
    this.announce();
  }

  // Build a look off screen and swap it in whole. Every wait rechecks that this request still owns the board (a newer request,
  // a new deal or the renderer's disposal ends it), and a look that finishes after that is disposed, never shown.
  private async growLook(id: number, look: LandLook, spec: { key: string; hexes: LandHex[] }, tries: number) {
    const alive = () => id === this.buildId && !this.stopped;
    // Not until the board's first frame is on screen: the chunk's parse and the first kind's build would otherwise hold it.
    while (this.renders === 0) {
      await new Promise((r) => requestAnimationFrame(r));
      if (!alive()) return;
    }
    performance.mark("props-start");
    let made: LandAppearance | null = null;
    try {
      this.stage(id, "import");
      const make = await this.loadLook(look);
      if (!alive()) return;
      this.stage(id, "build");
      made = await make(spec.hexes, spec.key, () => new Promise<boolean>((r) => setTimeout(() => r(alive()), 0)), this.lite);
      if (!alive()) return made?.dispose();
      if (!made) throw new Error("the look was not built");
      // Its shaders compile before it swaps in (in parallel where the browser can, KHR_parallel_shader_compile), not in the
      // first frame that draws it.
      this.stage(id, "compile");
      await this.compileLook(made);
      if (!alive()) return made.dispose();
      const done = made;
      made = null;
      this.publish(done, look, spec);
    } catch (e) {
      made?.dispose();
      if (!alive()) return;
      this.landStage = null;
      this.landError = `${look === "classic" ? "Classic" : "Jelly"} could not load`;
      if (tries >= LAND_MAX_RETRIES) {
        this.landPhase = "failed";
        console.warn(this.landError, e);
      } else {
        this.landPhase = "waiting";
        this.retryTimer = setTimeout(() => {
          if (!alive()) return;
          this.landRetries = tries + 1;
          this.landPhase = "building";
          this.announce();
          void this.growLook(id, look, spec, tries + 1);
        }, this.retryMs);
      }
      this.announce();
    }
  }

  // The shaders of a look compiled in place, into the composer's own target, so the programs are the frame's. Without
  // parallel compile it would only move the same stall earlier (and three warns), so there it is skipped.
  private async compileInPlace(look: LandAppearance) {
    if (!this.renderer.extensions.has("KHR_parallel_shader_compile")) return;
    look.update(this.jellyT, true, true);
    this.living.add(look.group);
    const was = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.composer.readBuffer);
    const done = this.renderer.compileAsync(this.scene, this.cam());
    this.renderer.setRenderTarget(was);
    this.living.remove(look.group);
    await done;
  }

  // The swap, in one synchronous step: the new look takes the wayfarer's hex, the glows under way and the camera's view, then
  // replaces the old look (and the slabs) in the scene, and only then is the old one disposed. Nothing shared is touched, and
  // nothing here replays a roll, a sound or a payout.
  private publish(next: LandAppearance, look: LandLook, spec: { key: string; hexes: LandHex[] }) {
    const prev = this.look;
    next.robber(this.lastState?.robberHex ?? null);
    for (const f of this.flashes) next.glow(f.id, f.mat.emissiveIntensity);
    next.update(this.jellyT, true, true);
    this.pushVisibility(next);
    this.living.add(next.group);
    if (prev) this.living.remove(prev.group);
    this.look = next;
    this.lookOn = look;
    if (this.slabs) {
      this.land.remove(this.slabs);
      this.slabs.dispose();
      (this.slabs.material as THREE.Material).dispose();
      this.slabs = null;
    }
    prev?.dispose();
    // The new ground beside the token can stand off the old: the wayfarer steps onto it.
    const rh = this.lastState?.hexes.find((h) => h.id === this.lastState?.robberHex);
    if (rh) {
      this.robberSpot(rh);
      if (!this.walk) this.wayfarer.position.copy(this.robberTarget);
    }
    // The jelly shore belongs to the board, not to a look: loaded once per board, and a look change leaves it as it is. A
    // shore that fails to load or build leaves the plain beach and docks (said once a page).
    const gen = this.landGen;
    if (HARBOR_JELLY && !this.lite && this.shoreGen !== gen) {
      this.shoreGen = gen;
      loadShore()
        .then(({ buildShore }) => gen === this.landGen && !this.stopped && this.swapShore(buildShore(this.coast, this.docks, hashStr(`${spec.key}|shore`))))
        .catch((e: unknown) => {
          if (!shoreFailed) console.warn("The jelly shore did not load; the plain beach stays.", e);
          shoreFailed = true;
        });
    }
    this.landPhase = "ready";
    this.landStage = null;
    this.landRetries = 0;
    this.landError = null;
    (window as unknown as { __terrain: TerrainStats }).__terrain = this.terrainStats();
    this.announce();
    this.wake();
    performance.mark("props-end");
  }

  // The camera and the tokens, by value and frozen, for a look that keeps tall things off the numerals (#759): sent when the
  // view, the eye or the tokens' pose change, and to a look before it is shown. It holds no token, camera or scene object.
  private pushVisibility(look: LandAppearance | null = this.look) {
    if (!look) return;
    const diorama = this.view === "diorama";
    const eye = this.cam().position;
    const az = diorama ? this.orbit.getAzimuthalAngle() : 0;
    const key = `${this.view}|${az}|${eye.x}|${eye.y}|${eye.z}|${this.tokens.length}|${this.tokens[0]?.position.y}`;
    if (look === this.visFor && key === this.visKey) return;
    this.visFor = look;
    this.visKey = key;
    const tilt = diorama ? TOKEN_TILT : 0;
    const tokens = this.tokens.map((t) =>
      Object.freeze({ x: t.position.x, y: t.position.y, z: t.position.z, glyphBottom: t.position.y + (TOKEN_H / 2 + 0.001) * Math.cos(tilt) - GLYPH_BOTTOM * Math.sin(tilt) }),
    );
    const context: VisibilityContext = Object.freeze({ view: this.view, camera: Object.freeze({ x: eye.x, y: eye.y, z: eye.z }), azimuth: az, tokens: Object.freeze(tokens) });
    look.setVisibilityContext(context);
  }

  private buildLand(state: GameState) {
    this.docksDirty = true;
    this.look?.dispose();
    this.look = null;
    this.lookOn = null;
    this.visFor = null;
    this.slabs = null;
    disposeGroup(this.land);
    disposeGroup(this.living);
    this.shore?.dispose();
    this.shore = null;
    this.beach.visible = true;
    if (this.crystal && this.baseWash && this.crystal.wash !== this.baseWash) {
      this.crystal.group.remove(this.crystal.wash);
      dropMesh(this.crystal.wash);
      this.crystal.group.add(this.baseWash);
      this.crystal.wash = this.baseWash;
    }
    this.boats = [];
    this.docks = [];
    this.piers = [];
    this.living.add(this.wayfarer);
    this.pickables = [];
    this.tokens = [];
    this.caps.clear();
    this.flashes = [];
    this.oceanLife.reset(landKey(state));

    // Each hex: an unseen block to pick it by, a stand-in slab in its terrain's paint, and its token.
    const slabs = (this.slabs = new THREE.InstancedMesh(SLAB_GEO, new THREE.MeshStandardMaterial({ roughness: 0.85 }), state.hexes.length));
    slabs.castShadow = slabs.receiveShadow = true;
    state.hexes.forEach((h, i) => {
      const { x, z } = worldOfHex(h);
      const pick = new THREE.Mesh(SLAB_GEO, PICK_MAT);
      pick.position.set(x, TILE_Y, z);
      pick.userData = { kind: "hex", id: h.id, land: true };
      this.land.add(pick);
      this.pickables.push(pick);
      slabs.setMatrixAt(i, _slab.makeTranslation(x, TILE_Y, z));
      slabs.setColorAt(i, _slabColor.set(PAINT[h.terrain][0]));
      this.caps.set(h.id, { emissiveIntensity: 0 });
      if (h.pip != null) {
        const tok = numberToken(h.pip);
        tok.userData.token = h.pip;
        tok.userData.hex = h.id;
        tok.userData.restY = topOf(h.terrain) + 0.04;
        tok.userData.lift = 0;
        tok.position.set(x, topOf(h.terrain) + 0.04, z);
        this.land.add(tok);
        this.tokens.push(tok);
      }
    });
    this.land.add(slabs);

    // The land look: loaded and built a kind per task after the first draw (#543 restore budget), so no one task holds the page;
    // then the island swaps in whole. A rebuild or a dispose before then drops it, and the stand-in slabs are the new board's.
    this.landGen++;
    this.landSpec = { key: landKey(state), hexes: state.hexes.map((h) => ({ id: h.id, terrain: h.terrain, q: h.q, r: h.r, ...worldOfHex(h), y: TILE_Y })) };
    this.requestLook();

    // A dock spans a coastal edge, so both its corners carry the harbor; the deal spaces docks at least three edges apart, so two
    // neighbouring harbor corners on the coast loop of one kind are always one dock. One pier and one boat per dock.
    const vbyId = new Map(state.vertices.map((v) => [v.id, v]));
    const n = this.coastOrder.length;
    for (let i = 0; i < n; i++) {
      const va = vbyId.get(this.coastOrder[i]!);
      const vb = vbyId.get(this.coastOrder[(i + 1) % n]!);
      if (!va?.harbor || va.harbor !== vb?.harbor) continue;
      const ma = this.coastMiter.get(va.id)!;
      const mb = this.coastMiter.get(vb.id)!;
      const cx = (va.x + vb.x) / 2;
      const cz = (va.z + vb.z) / 2;
      const mx = (ma.mx + mb.mx) / 2;
      const mz = (ma.mz + mb.mz) / 2;
      const jettyStart = 0.22; // the beach's own outer offset (docs/design/ocean.md)
      const jettyLen = 0.24; // ends at 0.46: just past the foam's 0.42 outer offset
      const pier = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.05, jettyLen),
        new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.82 }),
      );
      pier.position.set(cx + mx * (jettyStart + jettyLen / 2), 0.1, cz + mz * (jettyStart + jettyLen / 2));
      pier.lookAt(cx + mx, 0.1, cz + mz);
      pier.castShadow = true;
      this.land.add(pier);
      this.piers.push(pier);
      this.docks.push({ cx, cz, mx, mz, kind: va.harbor, vids: [va.id, vb.id] });

      const boat = makeBoat(va.harbor);
      boat.position.set(cx + mx * (jettyStart + jettyLen + 0.16), 0.08, cz + mz * (jettyStart + jettyLen + 0.16));
      boat.lookAt(cx, 0.08, cz);
      boat.userData.vids = [va.id, vb.id];
      boat.userData.kind = va.harbor;
      this.living.add(boat);
      this.boats.push(boat);
    }
  }

  // A new board (or a first one, as on a reconnect) is drawn standing; only pieces added since the last board land.
  private buildPieces(state: GameState, fresh: boolean) {
    disposeGroup(this.pieces);
    const now = performance.now();
    if (fresh) this.landStart.clear();
    const before = fresh ? new Map<string, PieceKind>() : this.placed;
    const calm = this.calm();
    this.placed = new Map();
    this.landings = [];
    const land = (obj: THREE.Object3D, key: string, kind: PieceKind, seat: string) => {
      obj.userData = { piece: kind, key, restY: obj.position.y };
      this.placed.set(key, kind);
      const start = !fresh && !calm && before.get(key) !== kind ? now : this.landStart.get(key);
      if (start === undefined || now - start >= LAND_MS[LAND_SOUND[kind]]) {
        this.landStart.delete(key);
        return;
      }
      this.landStart.set(key, start);
      const l = { obj, kind, start, restY: obj.position.y };
      this.landings.push(l);
      poseLanding(l, now);
    };
    const vmap = new Map(state.vertices.map((v) => [v.id, v]));
    const pmap = new Map(state.players.map((p) => [p.id, p]));
    const tops = hexTops(state);

    for (const e of state.edges) {
      if (!e.path) continue;
      const a = vmap.get(e.va)!;
      const b = vmap.get(e.vb)!;
      const color = pmap.get(e.path)?.color ?? "#ccc";
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const rot = Math.atan2(dx, dz);
      const road = (JELLY_PIECES ? makeJellyPath : makePath)(color, Math.hypot(dx, dz) * 0.9);
      road.position.set((a.x + b.x) / 2, edgeTop(tops, a, b), (a.z + b.z) / 2);
      road.rotation.y = rot;
      this.pieces.add(road);
      land(road, `e:${e.id}`, "path", color);
    }

    for (const v of state.vertices) {
      if (!v.building) continue;
      const color = pmap.get(v.building.playerId)?.color ?? "#ccc";
      const house = JELLY_PIECES
        ? v.building.kind === "stronghold" ? makeJellyStronghold(color) : makeJellyOutpost(color)
        : v.building.kind === "stronghold" ? makeStronghold(color) : makeOutpost(color);
      house.position.set(v.x, vertexTop(tops, v), v.z);
      this.pieces.add(house);
      land(house, `v:${v.id}`, v.building.kind, color);
    }

    this.paintSails(state);
  }

  // A claimed dock's sail wears the claiming seat's colour.
  private paintSails(state: GameState) {
    const vmap = new Map(state.vertices.map((v) => [v.id, v]));
    const pmap = new Map(state.players.map((p) => [p.id, p]));
    for (const b of this.boats) {
      const corners = ((b.userData.vids as string[] | undefined) ?? []).map((id) => vmap.get(id));
      const claimed = (corners.find((v) => v?.building) ?? null)?.building?.playerId;
      const sail = b.getObjectByName("sail") as THREE.Mesh | undefined;
      if (sail && sail.material instanceof THREE.MeshStandardMaterial) {
        sail.material.color.set(claimed ? pmap.get(claimed)?.color ?? "#eee" : "#f4efe4");
      }
    }
  }

  // The jelly shore swaps in for the plain beach, piers and boats; its boats take their places on the swell.
  private swapShore(shore: Shore) {
    for (const p of this.piers) p.visible = false;
    for (const b of this.boats) {
      this.living.remove(b);
      disposeGroup(b);
    }
    // The ships, the rowboats and the buoys ride the swell as the plain boats did. Yaw alone (no lookAt): the tick writes
    // pitch and roll over x and z, so a lookAt's flipped Euler would not survive it.
    this.boats = shore.floaters;
    for (const b of shore.floaters) {
      const rest = b.userData.rest as { x: number; z: number; yaw: number };
      b.position.set(rest.x, 0.07, rest.z);
      b.rotation.set(0, rest.yaw, 0);
    }
    this.beach.visible = false;
    // The crystal sea's lace and swash move out to the apron's waterline.
    if (this.crystal) {
      const wash = makeWash(shore.waterline, this.sea);
      wash.visible = this.crystal.wash.visible;
      this.crystal.group.remove(this.crystal.wash);
      if (this.crystal.wash !== this.baseWash) dropMesh(this.crystal.wash);
      this.crystal.group.add(wash);
      this.crystal.wash = wash;
    }
    this.shore = shore;
    this.living.add(shore.group);
    if (this.lastState) this.paintSails(this.lastState);
    this.wake();
  }

  // Pose every landing piece for this moment; a finished one is left exactly at rest. Reduced motion skips to rest.
  private stepLandings(now: number, calm: boolean) {
    if (!this.landings.length) return;
    for (const l of this.landings) poseLanding(l, calm ? Infinity : now);
    this.landings = this.landings.filter((l) => !calm && now - l.start < LAND_MS[LAND_SOUND[l.kind]]);
    for (const [key, start] of this.landStart) if (calm || now - start >= LAND_MAX) this.landStart.delete(key);
  }

  private buildMarks(state: GameState, hi: Highlights, interactive: boolean) {
    disposeGroup(this.marks);
    this.pickables = this.pickables.filter((o) => o.userData.kind === "hex" && o.userData.land);
    this.legalIds = interactive ? new Set([...hi.vertices, ...hi.edges, ...hi.hexes]) : new Set();
    if (!interactive) return;
    const vset = new Set(hi.vertices);
    const eset = new Set(hi.edges);
    const hset = new Set(hi.hexes);
    const vmap = new Map(state.vertices.map((v) => [v.id, v]));
    const tops = hexTops(state);
    // Marks show only for the seat to act, so that seat's colour is the one every mark wears.
    const seat = new THREE.Color(state.players.find((p) => p.id === state.current)?.color ?? "#fff6e8");
    // The glow leans toward cream so a dark seat (Pine) still reads on forest at the pulse trough; the hue stays the seat's.
    const glow = seat.clone().lerp(new THREE.Color(0xfff6e8), 0.35);

    for (const v of state.vertices) {
      if (!vset.has(v.id)) continue;
      const m = new THREE.Mesh(
        new THREE.TorusGeometry(0.13, 0.025, 8, 24),
        new THREE.MeshStandardMaterial({ color: seat, emissive: glow, emissiveIntensity: 0.8 }),
      );
      m.rotation.x = Math.PI / 2;
      m.position.set(v.x, vertexTop(tops, v) + 0.03, v.z);
      m.userData = { kind: "vertex", id: v.id, baseGlow: 0.8 };
      this.marks.add(m);
      const pick = new THREE.Mesh(new THREE.SphereGeometry(PICK_VERTEX_RADIUS, 8, 6), new THREE.MeshBasicMaterial());
      pick.visible = false;
      pick.position.copy(m.position);
      pick.userData = { kind: "vertex", id: v.id };
      this.marks.add(pick);
      this.pickables.push(pick);
    }
    for (const e of state.edges) {
      if (!eset.has(e.id)) continue;
      const a = vmap.get(e.va)!;
      const b = vmap.get(e.vb)!;
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.07, Math.hypot(b.x - a.x, b.z - a.z) * 0.72),
        new THREE.MeshStandardMaterial({ color: seat, emissive: glow, emissiveIntensity: 0.45 }),
      );
      m.position.set((a.x + b.x) / 2, edgeTop(tops, a, b) + 0.035, (a.z + b.z) / 2);
      m.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
      m.userData = { kind: "edge", id: e.id, baseGlow: 0.45 };
      this.marks.add(m);
      const len = Math.hypot(b.x - a.x, b.z - a.z) * PICK_EDGE.lengthScale;
      const pick = new THREE.Mesh(new THREE.BoxGeometry(PICK_EDGE.w, PICK_EDGE.h, len), new THREE.MeshBasicMaterial());
      pick.visible = false;
      pick.position.copy(m.position);
      pick.rotation.y = m.rotation.y;
      pick.userData = { kind: "edge", id: e.id };
      this.marks.add(pick);
      this.pickables.push(pick);
    }
    for (const h of state.hexes) {
      if (!hset.has(h.id)) continue;
      const { x, z } = worldOfHex(h);
      const ring = new THREE.Mesh(
        hexRing(HEX_SIZE * 0.94, HEX_SIZE * 0.76),
        new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xffb347, emissiveIntensity: 0.6, roughness: 0.6 }),
      );
      ring.position.set(x, topOf(h.terrain) + 0.012, z);
      ring.userData = { kind: "hex", id: h.id, baseGlow: 0.6 };
      this.marks.add(ring);
      this.pickables.push(ring);
    }
    this.setPending(this.pending);
  }
}

// Each hex id's top y.
function hexTops(state: GameState) {
  return new Map(state.hexes.map((h) => [h.id, topOf(h.terrain)]));
}

// A corner sits on the highest hex it touches.
function vertexTop(tops: Map<string, number>, v: Vertex) {
  return Math.max(...v.hexes.map((id) => tops.get(id) ?? 0));
}

// An edge sits on the higher of the (one or two) hexes its two corners share.
function edgeTop(tops: Map<string, number>, a: Vertex, b: Vertex) {
  const shared = a.hexes.filter((id) => b.hexes.includes(id));
  return Math.max(...(shared.length ? shared : a.hexes).map((id) => tops.get(id) ?? 0));
}

// Everything buildLand draws: each hex's terrain and token, and the corners that hold a dock.
function landKey(state: GameState) {
  const hexes = state.hexes.map((h) => `${h.id}:${h.terrain}:${h.pip ?? ""}`).join(",");
  const docks = state.vertices.filter((v) => v.harbor).map((v) => v.id).join(",");
  return `${hexes}|${docks}`;
}

// The chrome a tap cannot pass through, one box per child of the shell, in canvas pixels. An element that takes pointer
// events catches taps across its whole box, so it is its own box and nothing more (clipped overflow and sr-only text do not
// count), even when a decorative child inside it (absolute or fixed, pointer-events: none: a flash, a fade) lets taps through.
// An element that lets taps through is only the union of what is inside it, and so is a taking element with such an in-flow
// child, since that child is what gives it its size: the chat dock measures as its button and not as the 288 px preview list.
function solidRects(shell: Element, canvas: Element): Rect[] {
  const base = canvas.getBoundingClientRect();
  const local = (el: Element): Rect => {
    const r = el.getBoundingClientRect();
    return { left: r.left - base.left, top: r.top - base.top, right: r.right - base.left, bottom: r.bottom - base.top };
  };
  const join = (a: Rect | null, b: Rect | null): Rect | null =>
    !a ? b : !b ? a : { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
  const box = (el: Element): { r: Rect | null; porous: boolean } => {
    if (el === canvas || el.hasAttribute("data-board-overlay")) return { r: null, porous: false };
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return { r: null, porous: false };
    const kids = [...el.children].map(box);
    let u: Rect | null = null;
    for (const k of kids) u = join(u, k.r);
    if (cs.pointerEvents === "none") return { r: u, porous: cs.position !== "absolute" && cs.position !== "fixed" };
    // A taking element whose only parts let taps through is still itself a target: its own box.
    if (kids.some((k) => k.porous)) return { r: u ?? local(el), porous: true };
    return { r: local(el), porous: false };
  };
  return [...shell.children].map((k) => box(k).r).filter((r): r is Rect => r !== null);
}

// True inside a region that scrolls on its own (the chat log, the bottom stack), where Home means "to the top".
function inScroller(el: HTMLElement | null): boolean {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight) return true;
  }
  return false;
}

// A mesh's own geometry and material (the crystal sea's moved wash).
function dropMesh(m: THREE.Mesh) {
  m.geometry.dispose();
  (m.material as THREE.Material).dispose();
}

function disposeGroup(g: THREE.Group) {
  while (g.children.length) {
    const c = g.children.pop()!;
    c.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat && !(mat as THREE.Material).userData?.shared) mat.dispose?.();
    });
  }
}

// The sea: an unlit shader, so the sun cannot paint a hotspot on it. Shallow to deep, a slow ripple, then the fog.
// A calm teal that never competes with the land: the ripple scales the colour by a few percent rather than adding to it
// (an added 0.022 was a third of the deep colour's linear value and drew dark blotches across the whole sea).
function makeWater() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uShallow: { value: new THREE.Color(0x65d8cb) },
      uDeep: { value: new THREE.Color(0x158e9a) },
      uFog: { value: PAPER.clone() },
      uFade: { value: new THREE.Vector2(11, 22) },
    },
    vertexShader: /* glsl */ `
      // The circle is local XY; +Z is up after the mesh's rotation. Crests stay at or below y = 0.
      uniform float uTime;
      varying vec2 vXZ;
      void main() {
        vec3 p = position;
        p.z += sin(p.x * 1.6 + uTime * 0.55) * sin(p.y * 1.25 + uTime * 0.40) * 0.012;
        vec4 world = modelMatrix * vec4(p, 1.0);
        vXZ = world.xz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uShallow;
      uniform vec3 uDeep;
      uniform vec3 uFog;
      uniform vec2 uFade;
      varying vec2 vXZ;
      ${CAUSTIC_GLSL}
      void main() {
        float d = length(vXZ);
        vec3 c = mix(uShallow, uDeep, smoothstep(8.0, 28.0, d));
        vec2 p = vXZ + vec2(sin(vXZ.y * 0.9 + uTime * 0.32), cos(vXZ.x * 0.7 - uTime * 0.25)) * 0.16;
        float ripple = sin(p.x * 2.1 + uTime * 0.45) * sin(p.y * 1.7 - uTime * 0.36);
        float light = caustic(p * 1.7 + vec2(uTime * 0.04, -uTime * 0.025));
        c *= 1.0 + 0.035 * ripple;
        c = mix(c, vec3(0.78, 0.97, 0.92), light * 0.07 * (1.0 - smoothstep(8.0, 20.0, d)));
        c = mix(c, uFog, smoothstep(uFade.x, uFade.y, d));
        gl_FragColor = vec4(c, 0.88);
      }
    `,
  });
}

// The island's outline: the coastal corners of the 19 hexes in order, each with its outward miter (#130).
function coastLoop() {
  const pts = new Map<string, { x: number; z: number }>();
  const edges = new Map<string, { a: string; b: string; n: number }>();
  for (const { q, r } of hexesInRadius(2)) {
    const ids = hexCorners(q, r).map((c) => {
      const id = vertexId(c.x, c.z);
      pts.set(id, c);
      return id;
    });
    for (let i = 0; i < 6; i++) {
      const a = ids[i]!;
      const b = ids[(i + 1) % 6]!;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const e = edges.get(key);
      if (e) e.n += 1;
      else edges.set(key, { a, b, n: 1 });
    }
  }
  // An edge is coastal when exactly one hex uses it.
  const next = new Map<string, string[]>();
  for (const e of edges.values()) {
    if (e.n !== 1) continue;
    next.set(e.a, [...(next.get(e.a) ?? []), e.b]);
    next.set(e.b, [...(next.get(e.b) ?? []), e.a]);
  }
  const start = next.keys().next().value!;
  const loop = [start];
  let prev = start;
  let cur = next.get(start)![0]!;
  while (cur !== start) {
    const ns = next.get(cur)!;
    if (ns.length !== 2 || loop.length > next.size) throw new Error("coast walk: the outline forks or does not close");
    loop.push(cur);
    const to = ns[0] === prev ? ns[1]! : ns[0]!;
    prev = cur;
    cur = to;
  }
  if (loop.length !== next.size) throw new Error("coast walk: more than one island");

  // The outward normal of edge p->q: the perpendicular on the side away from the origin (the island is centered there).
  const normal = (p: { x: number; z: number }, q: { x: number; z: number }) => {
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const l = Math.hypot(dx, dz);
    let nx = dz / l;
    let nz = -dx / l;
    if (nx * (p.x + q.x) + nz * (p.z + q.z) < 0) {
      nx = -nx;
      nz = -nz;
    }
    return { nx, nz };
  };
  return loop.map((id, i) => {
    const p = pts.get(id)!;
    const a = normal(pts.get(loop[(i + loop.length - 1) % loop.length]!)!, p);
    const b = normal(p, pts.get(loop[(i + 1) % loop.length]!)!);
    let mx = a.nx + b.nx;
    let mz = a.nz + b.nz;
    const ml = Math.hypot(mx, mz);
    mx /= ml;
    mz /= ml;
    if (mx * p.x + mz * p.z <= 0) throw new Error("coast walk: a miter points into the island");
    // Scale so an offset d along the miter sits d away from both edges.
    const k = 1 / (mx * a.nx + mz * a.nz);
    return { id, x: p.x, z: p.z, mx: mx * k, mz: mz * k };
  });
}

// One flat strip between two offsets from the coast, facing up.
function coastStrip(coast: ReturnType<typeof coastLoop>, inner: number, outer: number) {
  const pos: number[] = [];
  for (const c of coast) pos.push(c.x + c.mx * inner, 0, c.z + c.mz * inner, c.x + c.mx * outer, 0, c.z + c.mz * outer);
  const idx: number[] = [];
  const n = coast.length;
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    idx.push(a, a + 1, b + 1, a, b + 1, b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // The loop's direction is whatever the walk found. Flip the winding if the strip faces down.
  if (geo.attributes.normal!.getY(0) < 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2]!, idx[i + 1]!];
    geo.setIndex(idx);
    geo.computeVertexNormals();
  }
  return geo;
}

function hexShape(size: number) {
  const s = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    const x = size * Math.cos(a);
    const y = size * Math.sin(a);
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}

function hexRing(outer: number, inner: number) {
  const s = hexShape(outer);
  s.holes.push(hexShape(inner));
  const geo = new THREE.ShapeGeometry(s);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export function numberToken(n: number) {
  const g = new THREE.Group();
  const hot = n === 6 || n === 8;
  // A cream face on a thin disc whose edge (a ring round the face, and its side) is caramel-dark, or red for 6 and 8: the
  // edge is the contrast on the light caps, the face on the dark ones (docs/design/tokens.md).
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(TOKEN_R, TOKEN_R, TOKEN_H, 40), new THREE.MeshStandardMaterial({ color: hot ? 0xb3261e : 0x6b3f22, roughness: 0.6 }));
  disc.castShadow = true;
  g.add(disc);
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff9f0";
  ctx.beginPath();
  ctx.arc(128, 128, 124, 0, Math.PI * 2);
  ctx.fill();
  const ink = hot ? "#b3261e" : "#1c1916";
  ctx.fillStyle = ink;
  // The numeral fills the face above the pips (#597: about 1.2x the glyph it was, so it still reads on the tilted diorama
  // token); a two-digit one is condensed to the face's chord.
  ctx.font = "bold 192px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const squeeze = Math.min(1, 176 / ctx.measureText(String(n)).width);
  ctx.setTransform(squeeze, 0, 0, 1, 128 * (1 - squeeze), 0);
  ctx.fillText(String(n), 128, 104);
  if (hot) {
    ctx.strokeStyle = ink;
    ctx.lineWidth = 10;
    ctx.lineJoin = "round";
    ctx.strokeText(String(n), 128, 104);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Pips r 14 at a 32 px pitch under the numeral (#599: from r 12 at 28, so they stay 2 px on the smaller token).
  const pips = 6 - Math.abs(n - 7);
  const span = (pips - 1) * 32;
  for (let i = 0; i < pips; i++) {
    ctx.beginPath();
    ctx.arc(128 - span / 2 + i * 32, 196, 14, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const label = new THREE.Mesh(new THREE.CircleGeometry(TOKEN_FACE, 40), new THREE.MeshBasicMaterial({ map: tex }));
  label.rotation.x = -Math.PI / 2;
  label.position.y = TOKEN_H / 2 + 0.001;
  g.add(label);
  return g;
}

const PIECE_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 });
PIECE_MAT.userData.shared = true; // disposeGroup leaves it alone

function tint(geo: THREE.BufferGeometry, hex: string) {
  const c = new THREE.Color(hex); // sRGB in, linear out: the same conversion material.color gets
  const a = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) c.toArray(a, i);
  geo.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return geo;
}

// A box whose bottom face is at y, centred on (x, z). Non-indexed, because ExtrudeGeometry is non-indexed
// and mergeGeometries refuses to mix the two.
function slab(w: number, h: number, d: number, hex: string, y = 0, x = 0, z = 0) {
  return tint(new THREE.BoxGeometry(w, h, d).toNonIndexed().translate(x, y + h / 2, z), hex);
}

function piece(parts: THREE.BufferGeometry[]) {
  const m = new THREE.Mesh(mergeGeometries(parts), PIECE_MAT);
  m.castShadow = true;
  return m;
}

function makeOutpost(seat: string) {
  const shape = new THREE.Shape();
  shape.moveTo(-0.14, 0);
  shape.lineTo(0.14, 0);
  shape.lineTo(0, 0.12);
  shape.closePath();
  const roof = tint(new THREE.ExtrudeGeometry(shape, { depth: 0.24, bevelEnabled: false }).translate(0, 0.22, -0.12), seat);
  return piece([
    slab(0.48, 0.04, 0.44, RIM.dark),
    slab(0.38, 0.04, 0.34, RIM.light, 0.04),
    slab(0.26, 0.14, 0.22, seat, 0.08),
    roof,
  ]);
}

function makeStronghold(seat: string) {
  const parts = [
    slab(0.54, 0.04, 0.54, RIM.dark),
    slab(0.44, 0.04, 0.44, RIM.light, 0.04),
    slab(0.32, 0.22, 0.32, seat, 0.08),
  ];
  for (const x of [-0.12, 0.12]) for (const z of [-0.12, 0.12]) parts.push(slab(0.08, 0.09, 0.08, seat, 0.3, x, z));
  return piece(parts);
}

type PieceKind = "path" | "outpost" | "stronghold";
const LAND_SOUND = { path: "path_place", outpost: "outpost_place", stronghold: "stronghold_place" } as const;
const LAND_MAX = Math.max(...Object.values(LAND_MS));
// polish.md: --ease-out for a path growing, --ease-snap for what lands (a small overshoot reads as weight).
const easeOut = (u: number) => 1 - (1 - u) ** 5;
const easeSnap = (u: number) => 1 + 2.70158 * (u - 1) ** 3 + 1.70158 * (u - 1) ** 2;

// A path grows from 0.2 along its edge; an outpost drops 0.2 and settles; a stronghold swaps in at 1.05 and settles.
function poseLanding(l: { obj: THREE.Object3D; kind: PieceKind; start: number; restY: number }, now: number) {
  const u = Math.min(1, Math.max(0, (now - l.start) / LAND_MS[LAND_SOUND[l.kind]]));
  const { obj } = l;
  if (u >= 1) {
    obj.position.y = l.restY;
    obj.scale.set(1, 1, 1);
  } else if (l.kind === "path") obj.scale.set(1, 1, 0.2 + 0.8 * easeOut(u));
  else if (l.kind === "outpost") obj.position.y = l.restY + 0.2 * (1 - easeSnap(u));
  else obj.scale.setScalar(1.05 - 0.05 * easeSnap(u));
}

function makePath(seat: string, len: number) {
  return piece([
    slab(0.36, 0.03, len, RIM.dark),
    slab(0.26, 0.03, len - 0.06, RIM.light, 0.03),
    slab(0.16, 0.04, len - 0.12, seat, 0.06),
    tint(new THREE.CylinderGeometry(0.12, 0.12, 0.045, 12).toNonIndexed().translate(0, 0.0825, 0), seat),
  ]);
}

function hullShape() {
  const s = new THREE.Shape();
  s.moveTo(0, -0.24); // stern, flat
  s.lineTo(0.09, -0.2);
  s.lineTo(0.09, 0.1);
  s.lineTo(0, 0.26); // bow, pointed
  s.lineTo(-0.09, 0.1);
  s.lineTo(-0.09, -0.2);
  s.closePath();
  return s;
}

const sailTextures = new Map<HarborKind, THREE.CanvasTexture>();

function sailTexture(kind: HarborKind): THREE.CanvasTexture {
  let tex = sailTextures.get(kind);
  if (tex) return tex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#f4efe4";
  ctx.fillRect(0, 0, 64, 64);
  if (kind !== "any") {
    ctx.fillStyle = PAINT[kind][0]; // the same terrain colour used on the hex sides
    ctx.fillRect(0, 44, 64, 20); // a resource-coloured band along the sail's foot
  }
  ctx.fillStyle = "#1c1915";
  ctx.font = "bold 30px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(kind === "any" ? "3:1" : "2:1", 32, kind === "any" ? 32 : 22);
  tex = new THREE.CanvasTexture(c);
  sailTextures.set(kind, tex);
  return tex;
}

function makeBoat(kind: HarborKind) {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(
    new THREE.ExtrudeGeometry(hullShape(), { depth: 0.09, bevelEnabled: false }),
    new THREE.MeshStandardMaterial({ color: 0x5a3a24, roughness: 0.7 }),
  );
  hull.rotation.x = -Math.PI / 2;
  hull.position.y = 0.045;
  hull.castShadow = true;
  g.add(hull);

  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 0.36, 6),
    new THREE.MeshStandardMaterial({ color: 0x3a2a1a }),
  );
  mast.position.y = 0.2;
  g.add(mast);

  const sail = new THREE.Mesh(
    new THREE.PlaneGeometry(0.3, 0.36),
    new THREE.MeshStandardMaterial({
      color: 0xf4efe4,
      map: sailTexture(kind),
      side: THREE.DoubleSide,
      roughness: 0.6,
    }),
  );
  sail.name = "sail";
  sail.position.set(0.04, 0.22, 0);
  g.add(sail);
  return g;
}



// The `?fps` overlay: per half second, the mean interval between drawn frames, the draw's CPU time, how far the GPU finished
// behind the draw (by its fence, read at the next animation frame), the draw calls and triangles of one frame, and the board.
type Fps = ReturnType<typeof makeFps>;
function makeFps(renderer: THREE.WebGLRenderer) {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;right:6px;top:calc(env(safe-area-inset-top) + 64px);z-index:9999;pointer-events:none;font:11px/1.35 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.6);padding:4px 6px;border-radius:4px;white-space:pre";
  document.body.appendChild(el);
  renderer.info.autoReset = false;
  let last = 0;
  let start = 0;
  let sentAt = 0;
  const acc = { n: 0, gap: 0, cpu: 0, cpuN: 0, gpu: 0, gpuN: 0, shown: 0 };
  return {
    el,
    begin(t0: number) {
      renderer.info.reset();
      start = t0;
      if (last) {
        acc.gap += t0 - last;
        acc.n++;
      }
      last = t0;
    },
    end(stats: { drawCalls: number; triangles: number } | null, lite: boolean) {
      const now = performance.now();
      acc.cpu += now - start;
      acc.cpuN++;
      sentAt = now;
      if (now - acc.shown < 500 || !acc.n) return;
      const r = renderer.info.render;
      el.textContent =
        `frame ${(acc.gap / acc.n).toFixed(1)} ms (${(1000 / (acc.gap / acc.n)).toFixed(0)} fps)\n` +
        `cpu ${(acc.cpu / acc.cpuN).toFixed(1)} ms  gpu ~${acc.gpuN ? (acc.gpu / acc.gpuN).toFixed(1) : "-"} ms\n` +
        `draws ${r.calls}  tris ${(r.triangles / 1000).toFixed(0)}k\n` +
        `board ${lite ? "lite" : "full"}${stats ? `  scenes ${stats.drawCalls} draws ${(stats.triangles / 1000).toFixed(0)}k` : "  (building)"}  dpr ${renderer.getPixelRatio()}`;
      Object.assign(acc, { n: 0, gap: 0, cpu: 0, cpuN: 0, gpu: 0, gpuN: 0, shown: now });
    },
    gpu(now: number) {
      if (!sentAt) return;
      acc.gpu += now - sentAt;
      acc.gpuN++;
      sentAt = 0;
    },
  };
}

// CSS --ease-snap is cubic-bezier(0.2, 0.8, 0.2, 1). Invert its x coordinate before evaluating y.
function snapBezier(u: number) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 16; i++) {
    const t = (lo + hi) / 2;
    const x = 0.6 * (1 - t) * t + t ** 3;
    if (x < u) lo = t;
    else hi = t;
  }
  const t = (lo + hi) / 2;
  return 2.4 * (1 - t) ** 2 * t + 3 * (1 - t) * t * t + t ** 3;
}
