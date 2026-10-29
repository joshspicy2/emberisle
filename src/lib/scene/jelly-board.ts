import * as THREE from "three";
import { type Terrain } from "@/lib/game/types";
import { setBoardDetail, tileSteps, type Tile } from "@/lib/scene/hex-jelly";
import { BLOCK_H } from "@/lib/scene/jelly-dims";
import type { LandAppearance, LandStats, VisibilityContext } from "@/lib/scene/land-appearance";

// The jelly board (#599, docs/design/hex-jelly-prompt.md): the six Hex Jelly scenes on the game board.
//
// One scene is built per kind (the owner, 2026-10-16: "shared for now") and drawn on every hex of that kind through a few
// BatchedMeshes. Every mesh of every scene goes into the batch for its material, with one instance per hex (an InstancedMesh's
// instances times the hexes), so the whole island is a few dozen draws however rich the scenes are. Each frame, every scene's
// own life runs once, and only the parts that moved are copied to their instances.
//
// A hex's own moments are per instance:
// - the roll payoff: the jelly squash and the ripple through its things, and the paying-hex glow;
// - a tap's wobble;
// - the wayfarer's dulling.
// The sprites (glows, fog and steam puffs) are camera-facing quads in two instanced draws, one added, one blended.

// The board's lattice: a hex fills about a fifth of the screen, where 12 rings are as smooth as the studio's 64.
const RINGS = 12;
// Times the scenes are sampled at to find what moves: anything whose matrix, visibility, instances or material changes.
const SAMPLES = [0.37, 1.91, 3.53, 5.2];
const ROLL_S = 2.4;
const TAP_S = 0.9;
// The wayfarer's shade on his hex: darker and cooler, as if a cloud stood over it.
const DULL = new THREE.Color(0.46, 0.48, 0.58);

export type JellyHex = { id: string; terrain: Terrain; x: number; z: number; y: number };
export type JellyStats = { lite: boolean; drawCalls: number; triangles: number; kinds: number; batches: number; bakes: number; sprites: number };
export type OcclusionHit = { point: { x: number; y: number; z: number }; kind: Terrain; seed: number };

type Batch = {
  mesh: THREE.BatchedMesh;
  // Each source geometry, prepared for this batch, and its id in it.
  geos: Map<THREE.BufferGeometry, number>;
  tris: Map<number, number>;
  rgba: boolean;
};
type Hx = {
  id: string;
  T: THREE.Matrix4;
  rollAt: number;
  tapAt: number;
  dull: number;
  dullTo: number;
  // This frame: the hex-level matrix (T times the squash) and the colour every one of its instances is multiplied by.
  M: THREE.Matrix4;
  fx: THREE.Color;
  // Its roll's phase this frame (-1 when not rolling), and whether its instances must be rewritten this frame.
  roll: number;
  dirty: boolean;
  wasActive: boolean;
  // The paying-hex glow, set by the game (0 to about 0.35), and what it was last frame.
  glow: number;
  glowWas: number;
  // Its slot in the per-hex uniforms the baked meshes read.
  slot: number;
};
type Leaf = {
  o: THREE.Mesh;
  n: number;
  moves: boolean;
  alpha: boolean;
  // The placed thing it belongs to (the ripple squashes it in turn) and that thing's delay, or the crowd's per instance.
  top: THREE.Object3D | null;
  delay: Float32Array | null;
  // Baked into a static mesh (drawn by the per-hex uniforms), or drawn as batch instances: ids[h * n + j].
  baked: boolean;
  batch: Batch | null;
  ids: Int32Array;
  base: THREE.Color[];
};
type SpriteLeaf = { o: THREE.Sprite; sb: SpriteBatch; first: number };
type Kind = { kind: Terrain; tile: Tile; hexes: Hx[]; leaves: Leaf[]; sprites: SpriteLeaf[] };

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _c = new THREE.Color();
const _c4 = new THREE.Vector4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _rot = new THREE.Quaternion();

// The ripple's squash at phase v (0 to 1) for a placed thing, or for one of a crowd.
const rippleQ = (roll: number, delay: number) => {
  const v = roll * 1.6 - delay;
  return v < 0 || v > 1 ? 0 : Math.sin(v * Math.PI * 3) * (1 - v) ** 1.4;
};

function visibleIn(o: THREE.Object3D, root: THREE.Object3D) {
  for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (!p.visible) return false;
  return true;
}

// The radius (world units) a mesh's things reach: its geometry's bounding sphere at its own scale, or its largest instance's.
const SHADOW_MIN = 0.03;
// Instances smaller than this (radius, world units) are left off the board: under two pixels at its zoom.
const SPECK = 0.006;
function sizeOf(o: THREE.Mesh) {
  const g = o.geometry;
  g.boundingSphere ?? g.computeBoundingSphere();
  let k = o.matrixWorld.getMaxScaleOnAxis();
  const im = o as THREE.InstancedMesh;
  if (im.isInstancedMesh) {
    let m = 0;
    for (let j = 0; j < im.count; j++) m = Math.max(m, im.getMatrixAt(j, _m).getMaxScaleOnAxis());
    k *= m;
  }
  return g.boundingSphere!.radius * k;
}

// What a material's batch is keyed by: its program and every setting the batch shares. Colour is per instance, and so is
// opacity where it changes over time. A material whose own uniforms or emissive change (the water's flow, a fire's glow) is
// its own batch and keeps its colour, so the scene's life still drives it.
function materialKey(m: THREE.Material, own: boolean, alpha: boolean) {
  const s = m as THREE.MeshStandardMaterial;
  const parts: unknown[] = [m.type, m.customProgramCacheKey(), m.transparent, m.depthWrite, m.depthTest, m.blending, m.side, m.toneMapped, alpha ? "a" : m.opacity];
  if (own) parts.push(m.uuid);
  if ("roughness" in s) parts.push(s.roughness, s.metalness, s.flatShading, s.emissive?.getHexString(), s.emissiveIntensity);
  if (s.map) parts.push(s.map.uuid);
  return parts.join("|");
}
const ownUniforms = (m: THREE.Material) => Object.values(m.userData).some((v) => v && typeof v === "object" && "value" in v);

// A non-indexed geometry (the merged parts, flat-shaded triangle by triangle) indexed for the board: each corner's normal is
// the mean of its neighbours' faces within CREASE of its own (so spheres turn smooth and boxes keep their edges), and corners
// that then match exactly (position, normal, colour, uv, aCrack) are shared. A batch draws every corner through a few texture
// reads, so this is most of a frame on a software GPU.
const CREASE = Math.cos((50 * Math.PI) / 180);
const INDEXED = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
function indexed(geo: THREE.BufferGeometry) {
  if (geo.index) return geo;
  const hit = INDEXED.get(geo);
  if (hit) return hit;
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const n = pos.count;
  const faces = n / 3;
  const fn = new Float32Array(faces * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let f = 0; f < faces; f++) {
    a.fromBufferAttribute(pos, f * 3);
    b.fromBufferAttribute(pos, f * 3 + 1);
    c.fromBufferAttribute(pos, f * 3 + 2);
    c.sub(b).cross(a.sub(b)).normalize();
    fn[f * 3] = c.x;
    fn[f * 3 + 1] = c.y;
    fn[f * 3 + 2] = c.z;
  }
  const q = (v: number) => Math.round(v * 2e5);
  const at = new Map<string, number[]>();
  const keys: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${q(pos.getX(i))},${q(pos.getY(i))},${q(pos.getZ(i))}`;
    keys[i] = k;
    let l = at.get(k);
    if (!l) at.set(k, (l = []));
    l.push(i);
  }
  const nor = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const f = Math.floor(i / 3);
    const [fx, fy, fz] = [fn[f * 3]!, fn[f * 3 + 1]!, fn[f * 3 + 2]!];
    let [x, y, z] = [0, 0, 0];
    for (const j of at.get(keys[i]!)!) {
      const g = Math.floor(j / 3);
      const [gx, gy, gz] = [fn[g * 3]!, fn[g * 3 + 1]!, fn[g * 3 + 2]!];
      if (gx * fx + gy * fy + gz * fz < CREASE) continue;
      x += gx;
      y += gy;
      z += gz;
    }
    const l = Math.hypot(x, y, z) || 1;
    nor[i * 3] = x / l;
    nor[i * 3 + 1] = y / l;
    nor[i * 3 + 2] = z / l;
  }
  // Share the corners that now match.
  const names = Object.keys(geo.attributes).filter((k) => k !== "normal");
  const attrs = names.map((k) => geo.getAttribute(k) as THREE.BufferAttribute);
  const seen = new Map<string, number>();
  const remap: number[] = [];
  const index: number[] = [];
  const qn = (v: number) => Math.round(v * 1e3);
  for (let i = 0; i < n; i++) {
    let k = `${keys[i]}|${qn(nor[i * 3]!)},${qn(nor[i * 3 + 1]!)},${qn(nor[i * 3 + 2]!)}`;
    for (const at of attrs) if (at !== pos) for (let c = 0; c < at.itemSize; c++) k += `,${qn(at.getComponent(i, c))}`;
    let v = seen.get(k);
    if (v === undefined) {
      v = remap.length;
      seen.set(k, v);
      remap.push(i);
    }
    index.push(v);
  }
  const out = new THREE.BufferGeometry();
  names.forEach((name, j) => {
    const src = attrs[j]!;
    const arr = new Float32Array(remap.length * src.itemSize);
    remap.forEach((i, r) => {
      for (let c = 0; c < src.itemSize; c++) arr[r * src.itemSize + c] = src.getComponent(i, c);
    });
    out.setAttribute(name, new THREE.BufferAttribute(arr, src.itemSize));
  });
  const na = new Float32Array(remap.length * 3);
  remap.forEach((i, r) => na.set(nor.subarray(i * 3, i * 3 + 3), r * 3));
  out.setAttribute("normal", new THREE.BufferAttribute(na, 3));
  out.setIndex(remap.length > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  INDEXED.set(geo, out);
  return out;
}

// A source geometry made ready for a batch: the batch's attributes exactly (position, normal, colour as RGB or RGBA,
// and uv or aCrack where its material reads them).
function prepare(geo: THREE.BufferGeometry, attrs: string[], rgba: boolean, readsColor: boolean) {
  const g = new THREE.BufferGeometry();
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const n = pos.count;
  g.setAttribute("position", pos);
  if (!geo.getAttribute("normal")) geo.computeVertexNormals();
  g.setAttribute("normal", geo.getAttribute("normal"));
  const src = readsColor ? (geo.getAttribute("color") as THREE.BufferAttribute | undefined) : undefined;
  const k = rgba ? 4 : 3;
  const col = new Float32Array(n * k);
  for (let i = 0; i < n; i++) {
    col[i * k] = src ? src.getX(i) : 1;
    col[i * k + 1] = src ? src.getY(i) : 1;
    col[i * k + 2] = src ? src.getZ(i) : 1;
    if (rgba) col[i * k + 3] = src && src.itemSize === 4 ? src.getW(i) : 1;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, k));
  for (const a of attrs) {
    const at = geo.getAttribute(a);
    g.setAttribute(a, at ?? new THREE.BufferAttribute(new Float32Array(n * (a === "uv" ? 2 : 1)), a === "uv" ? 2 : 1));
  }
  if (geo.index) g.setIndex(geo.index);
  return g;
}

// The board's one plain jelly material: a middle roughness for all, and smooth shading (the creased normals keep the facets
// of rocks and peaks).
function sharePlain(m: THREE.MeshStandardMaterial) {
  m.roughness = 0.7;
  m.metalness = 0;
  m.flatShading = false;
  m.vertexColors = true;
}

// A copy of a scene material that compiles the same (clone() copies neither onBeforeCompile nor its cache key).
function copyMaterial<M extends THREE.Material>(src: M): M {
  const c = src.clone() as M;
  c.onBeforeCompile = src.onBeforeCompile;
  c.customProgramCacheKey = src.customProgramCacheKey;
  return c;
}

// The per-hex values every baked mesh reads, by the hex's slot: its centre (x, z), its roll's phase (-1 when not rolling) and
// its squash; its tint (the glow and the dulling); the hexes' base height.
const MAX_HEX = 64;
type HexU = { uHexA: { value: THREE.Vector4[] }; uHexT: { value: THREE.Vector3[] }; uBaseY: { value: number } };

// Teach a material the baked mesh's per-hex moments, in the vertex shader: the roll's ripple squashes each thing about its
// pivot (aPivot.xyz) after its delay (aPivot.w; below 0, never), the hex squashes about its centre, and its tint multiplies
// the colour.
function hexPatch(m: THREE.Material, u: HexU) {
  const before = m.onBeforeCompile;
  const key = m.customProgramCacheKey();
  m.onBeforeCompile = (sh, r) => {
    before.call(m, sh, r);
    sh.uniforms.uHexA = u.uHexA;
    sh.uniforms.uHexT = u.uHexT;
    sh.uniforms.uBaseY = u.uBaseY;
    sh.vertexShader =
      `attribute float aHex;\nattribute vec4 aPivot;\nuniform vec4 uHexA[ ${MAX_HEX} ];\nuniform vec3 uHexT[ ${MAX_HEX} ];\nuniform float uBaseY;\nvarying vec3 vHexTint;\n` +
      sh.vertexShader.replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        vec4 hA = uHexA[ int( aHex + 0.5 ) ];
        if ( hA.z >= 0.0 && aPivot.w >= 0.0 ) {
          float rv = hA.z * 1.6 - aPivot.w;
          if ( rv > 0.0 && rv < 1.0 ) {
            float rq = sin( rv * 9.424778 ) * pow( 1.0 - rv, 1.4 );
            transformed = aPivot.xyz + ( transformed - aPivot.xyz ) * vec3( 1.0 - 0.12 * rq, 1.0 + 0.22 * rq, 1.0 - 0.12 * rq );
          }
        }
        vec3 hC = vec3( hA.x, uBaseY, hA.y );
        transformed = hC + ( transformed - hC ) * vec3( 1.0 - 0.03 * hA.w, 1.0 + 0.07 * hA.w, 1.0 - 0.03 * hA.w );
        vHexTint = uHexT[ int( aHex + 0.5 ) ];`,
      );
    sh.fragmentShader = "varying vec3 vHexTint;\n" + sh.fragmentShader.replace("#include <color_fragment>", "#include <color_fragment>\n\tdiffuseColor.rgb *= vHexTint;");
  };
  m.customProgramCacheKey = () => `${key}|hex`;
}

// The camera-facing quads: each instance's matrix places and sizes it (the sprite's world matrix), its colour and alpha are
// its own.
class SpriteBatch {
  mesh: THREE.InstancedMesh;
  color: THREE.InstancedBufferAttribute;
  count = 0;
  constructor(map: THREE.Texture | null, additive: boolean, toneMapped: boolean, max: number) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.color.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aColor", this.color);
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: map } }]),
      vertexShader: /* glsl */ `
        attribute vec4 aColor;
        varying vec4 vC;
        varying vec2 vUv;
        #include <fog_pars_vertex>
        void main() {
          vUv = uv;
          vC = aColor;
          vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
          vec2 sc = vec2( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 1 ].xyz ) );
          mvPosition.xy += position.xy * sc;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying vec4 vC;
        varying vec2 vUv;
        #include <fog_pars_fragment>
        void main() {
          vec4 t = texture2D( map, vUv );
          gl_FragColor = vec4( t.rgb * vC.rgb, t.a * vC.a );
          ${toneMapped ? "#include <tonemapping_fragment>" : ""}
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }
}

export class JellyBoard implements LandAppearance {
  readonly group = new THREE.Group();
  private kinds: Kind[] = [];
  private batches = new Map<string, Batch>();
  private bakes: THREE.Mesh[] = [];
  // Lite (a software GPU, where drawing shares the CPU with the page): the ground, its landforms and strata, nothing on it.
  private lite = false;
  private hexU: HexU = {
    uHexA: { value: Array.from({ length: MAX_HEX }, () => new THREE.Vector4(0, 0, -1, 0)) },
    uHexT: { value: Array.from({ length: MAX_HEX }, () => new THREE.Vector3(1, 1, 1)) },
    uBaseY: { value: 0 },
  };
  private sprites: SpriteBatch[] = [];
  private byHex = new Map<string, { k: Kind; h: Hx }>();
  private t = 0;
  private t0: number | undefined;

  private constructor() {
    this.group.name = "jelly-board";
  }

  // Build the scenes for these hexes, one per kind from its seed, and batch them; deterministic for the same hexes and seeds.
  // `pause` runs between kinds (a scene takes about a tenth of a second to build), so no one task holds the page for long; it
  // answers false when the board is no longer wanted, and the build stops there.
  static async create(hexes: JellyHex[], seedOf: (kind: Terrain) => number, pause: () => Promise<boolean>, lite = false) {
    const b = new JellyBoard();
    b.lite = lite;
    try {
      return await b.build(hexes, seedOf, pause);
    } catch (e) {
      // A build that throws leaves nothing behind.
      b.dispose();
      throw e;
    }
  }

  private async build(hexes: JellyHex[], seedOf: (kind: Terrain) => number, pause: () => Promise<boolean>): Promise<JellyBoard | null> {
    const b = this;
    const lite = this.lite;
    // A breath after the chunk itself loads and runs.
    if (!(await pause())) return null;
    for (const kind of [...new Set(hexes.map((h) => h.terrain))]) {
      // Built in its steps (the props, then the block), with a breath between; the board detail holds only while a step runs.
      const steps = tileSteps(kind, seedOf(kind), RINGS, true, lite);
      let tile: Tile | undefined;
      for (;;) {
        setBoardDetail(true);
        let step: IteratorResult<void, Tile>;
        try {
          step = steps.next();
        } finally {
          setBoardDetail(false);
        }
        if (step.done) {
          tile = step.value;
          break;
        }
        if (!(await pause())) {
          b.dispose();
          return null;
        }
      }
      const hx = hexes
        .filter((h) => h.terrain === kind)
        .map((h): Hx => ({ id: h.id, T: new THREE.Matrix4().makeTranslation(h.x, h.y, h.z), rollAt: -Infinity, tapAt: -Infinity, dull: 0, dullTo: 0, M: new THREE.Matrix4(), fx: new THREE.Color(1, 1, 1), roll: -1, dirty: true, wasActive: false, glow: 0, glowWas: 0, slot: 0 }));
      b.kinds.push({ kind, tile, hexes: hx, leaves: [], sprites: [] });
      if (!(await pause())) {
        b.dispose();
        return null;
      }
      // Index its geometry in slices of about 40 ms.
      const meshes: THREE.Mesh[] = [];
      tile.group.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
      let since = performance.now();
      for (const m of meshes) {
        indexed(m.geometry);
        if (performance.now() - since < 40) continue;
        if (!(await pause())) {
          b.dispose();
          return null;
        }
        since = performance.now();
      }
      if (!(await pause())) {
        b.dispose();
        return null;
      }
    }
    for (const k of b.kinds)
      for (const h of k.hexes) {
        h.slot = b.byHex.size;
        b.byHex.set(h.id, { k, h });
        b.hexU.uHexA.value[h.slot]?.set(h.T.elements[12]!, h.T.elements[14]!, -1, 0);
      }
    b.hexU.uBaseY.value = hexes[0]?.y ?? 0;
    if (!(await b.batch(pause))) {
      b.dispose();
      return null;
    }
    b.update(0, true);
    return b;
  }

  private async batch(pause: () => Promise<boolean>) {
    type Plan = { k: Kind; o: THREE.Mesh; moves: boolean; alpha: boolean; key: string; own: boolean; attrs: string[]; rgba: boolean; cast: boolean; plain: boolean };
    const plans: Plan[] = [];
    const spritePlans: { k: Kind; o: THREE.Sprite }[] = [];
    for (const k of this.kinds) {
      const root = k.tile.group;
      const leaves: THREE.Mesh[] = [];
      const sprites: THREE.Sprite[] = [];
      root.traverse((o) => {
        if ((o as THREE.Sprite).isSprite) sprites.push(o as THREE.Sprite);
        else if ((o as THREE.Mesh).isMesh) leaves.push(o as THREE.Mesh);
      });
      // Sample the scene's life to find what moves.
      const snap = (o: THREE.Mesh) => {
        const m = o.material as THREE.MeshStandardMaterial;
        const im = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).instanceMatrix.version : 0;
        return { w: o.matrixWorld.elements.join(), v: visibleIn(o, root), im, op: m.opacity, mat: `${m.emissiveIntensity}|${m.color?.getHexString()}|${m.emissive?.getHexString()}` };
      };
      const seen: ReturnType<typeof snap>[][] = leaves.map(() => []);
      for (const t of SAMPLES) {
        k.tile.update(t);
        root.updateMatrixWorld(true);
        leaves.forEach((o, i) => seen[i]!.push(snap(o)));
      }
      leaves.forEach((o, i) => {
        const s = seen[i]!;
        const differs = (f: (x: (typeof s)[0]) => unknown) => s.some((x) => f(x) !== f(s[0]!));
        const moves = differs((x) => x.w) || differs((x) => x.v) || differs((x) => x.im);
        const mat = o.material as THREE.Material;
        const alpha = differs((x) => x.op) && mat.transparent;
        const own = differs((x) => x.mat) || ownUniforms(mat);
        // Never drawn: hidden at every sample and not moving.
        if (!moves && !s[0]!.v) return;
        const geo = indexed(o.geometry);
        const attrs = [geo.getAttribute("aCrack") ? "aCrack" : "", mat.customProgramCacheKey().startsWith("jelly-water") ? "uv" : ""].filter(Boolean);
        // Only what is big enough to show a shadow at the board's scale casts one (a pebble's or a wheat stalk's is a pixel).
        const cast = o.castShadow && sizeOf(o) > SHADOW_MIN;
        // Each draw is most of what a frame costs on a software GPU, so the board shares them hard: every opaque thing on the
        // plain jelly program (ground, creatures, blobs, rocks, peaks) is one material, whatever its roughness or shading, and
        // shadows and draw order split only what is see-through. A water's own clock moves with the others', so waters share
        // by program too.
        const em = (mat as THREE.MeshStandardMaterial).emissive;
        const glows = !!em && em.getHex() !== 0 && (mat as THREE.MeshStandardMaterial).emissiveIntensity > 0;
        const plain = !!mat.userData.jellyPlain && !own && !alpha && !mat.transparent && !glows && mat.type === "MeshStandardMaterial";
        const flowing = own && !differs((x) => x.mat);
        const key = plain
          ? `plain|${attrs.join(",")}|${cast}`
          : `${materialKey(mat, own && !flowing, alpha)}|${attrs.join(",")}|${alpha ? "rgba" : "rgb"}|${mat.transparent ? `${o.renderOrder}|${cast}` : ""}`;
        plans.push({ k, o, moves, alpha, key, own, attrs, rgba: alpha, cast, plain });
      });
      for (const o of sprites) spritePlans.push({ k, o });
    }

    // Static or moving. A material whose own uniforms or emissive change serves only one kind of user: if any of its users
    // moves, all of them go to the batches.
    const movingOwn = new Set(plans.filter((p) => p.own && (p.moves || p.alpha)).map((p) => p.o.material));
    const fits = this.byHex.size <= MAX_HEX;
    const isStatic = (p: Plan) => fits && !p.moves && !p.alpha && !movingOwn.has(p.o.material);

    // Per source: its base colour per instance (the material's colour unless its own, times the instance's colour), the
    // placed thing it belongs to and the ripple's delay (the studio's own rule: a placed thing by its distance from the
    // centre, a crowd instance by its own).
    const leafOf = (p: Plan): Omit<Leaf, "batch" | "ids"> => {
      const im = p.o as THREE.InstancedMesh;
      const n = im.isInstancedMesh ? im.count : 1;
      const mc = p.own ? new THREE.Color(1, 1, 1) : ((p.o.material as THREE.MeshStandardMaterial).color?.clone() ?? new THREE.Color(1, 1, 1));
      const base = Array.from({ length: n }, (_, j) => {
        const c = mc.clone();
        if (im.isInstancedMesh && im.instanceColor) c.multiply(im.getColorAt(j, _c));
        return c;
      });
      const props = p.k.tile.group.children.find((c) => c.type === "Group");
      let top: THREE.Object3D | null = null;
      for (let q: THREE.Object3D | null = p.o; q && q.parent; q = q.parent) if (q.parent === props) top = q;
      let delay: Float32Array | null = null;
      if (im.isInstancedMesh) {
        delay = new Float32Array(n);
        for (let j = 0; j < n; j++) {
          im.getMatrixAt(j, _m);
          _p.setFromMatrixPosition(_m);
          delay[j] = (Math.max(0.3, Math.hypot(_p.x, _p.z)) - 0.3) * 0.5;
        }
        top = null;
      } else if (top) {
        const d = Math.hypot(top.position.x, top.position.z);
        if (top.userData.loose || d < 0.3) top = null;
        else delay = Float32Array.of((d - 0.3) * 0.5);
      }
      return { o: p.o, n, moves: p.moves, alpha: p.alpha, top, delay, base, baked: false };
    };

    // The static: baked, per material, into one mesh over every hex.
    const bakes = new Map<string, { plans: Plan[]; leaves: Omit<Leaf, "batch" | "ids">[] }>();
    // The ground last, within a bake and across them: the things on it draw first, so the depth test drops the ground they
    // cover before it is shaded (on a software GPU a frame is mostly its shading).
    const ground = (p: Plan) => p.o === p.k.tile.group.children[0] || p.o === p.k.tile.group.children[1];
    const statics = plans.filter(isStatic).sort((a, b) => Number(ground(a)) - Number(ground(b)));
    for (const p of statics) {
      const e = bakes.get(p.key) ?? { plans: [], leaves: [] };
      e.plans.push(p);
      e.leaves.push(leafOf(p));
      bakes.set(p.key, e);
    }
    // A bake is a pass over every corner it holds: it pauses every 40 ms or so, between its sources.
    let since = performance.now();
    const breathe = async () => {
      if (performance.now() - since < 40) return true;
      const ok = await pause();
      since = performance.now();
      return ok;
    };
    for (const e of bakes.values()) {
      const mesh = await this.bake(e.plans, e.leaves, breathe);
      if (!mesh) return false;
      // A bake of ground alone (the cracked tops, the strata) draws after the others.
      if (e.plans.every(ground) && !(mesh.material as THREE.Material).transparent) mesh.renderOrder = 1;
      this.group.add(mesh);
      e.plans.forEach((p, i) => p.k.leaves.push({ ...e.leaves[i]!, baked: true, batch: null, ids: new Int32Array(0) }));
      if (!(await breathe())) return false;
    }

    // The moving: a BatchedMesh per material, sized, then filled.
    const moving = plans.filter((p) => !isStatic(p));
    const sizes = new Map<string, { inst: number; verts: number; idx: number; geos: Set<THREE.BufferGeometry> }>();
    for (const p of moving) {
      const z = sizes.get(p.key) ?? { inst: 0, verts: 0, idx: 0, geos: new Set() };
      const n = (p.o as THREE.InstancedMesh).isInstancedMesh ? (p.o as THREE.InstancedMesh).count : 1;
      z.inst += n * p.k.hexes.length;
      const geo = indexed(p.o.geometry);
      if (!z.geos.has(geo)) {
        z.geos.add(geo);
        z.verts += geo.getAttribute("position").count;
        z.idx += geo.index!.count;
      }
      sizes.set(p.key, z);
    }
    for (const p of moving) {
      let b = this.batches.get(p.key);
      if (!b) {
        const z = sizes.get(p.key)!;
        const src = p.o.material as THREE.MeshStandardMaterial;
        // The batch draws with the first source's own material: its program and uniforms are the scene's. Colour comes per
        // instance (white here) unless it is the material's own batch; opacity per instance where it changes.
        let mat: THREE.Material = src;
        if (p.plain) {
          mat = copyMaterial(src);
          sharePlain(mat as THREE.MeshStandardMaterial);
        }
        if (p.rgba) {
          // Opacity comes per instance: a copy of the material at full opacity, reading the RGBA colour.
          mat = copyMaterial(src);
          mat.opacity = 1;
          (mat as THREE.MeshStandardMaterial).vertexColors = true;
        }
        const mesh = new THREE.BatchedMesh(z.inst, z.verts, Math.max(z.idx, 1), mat);
        mesh.frustumCulled = false;
        mesh.perObjectFrustumCulled = false;
        mesh.sortObjects = mat.transparent;
        mesh.castShadow = moving.some((q) => q.key === p.key && q.cast);
        mesh.receiveShadow = moving.some((q) => q.key === p.key && q.o.receiveShadow);
        mesh.renderOrder = p.o.renderOrder;
        b = { mesh, geos: new Map(), tris: new Map(), rgba: p.rgba };
        this.batches.set(p.key, b);
        this.group.add(mesh);
      }
      let gid = b.geos.get(p.o.geometry);
      if (gid === undefined) {
        const g = prepare(indexed(p.o.geometry), p.attrs, p.rgba, (p.o.material as THREE.Material & { vertexColors: boolean }).vertexColors);
        gid = b.mesh.addGeometry(g);
        b.geos.set(p.o.geometry, gid);
        b.tris.set(gid, g.index!.count / 3);
      }
      const L = leafOf(p);
      const ids = new Int32Array(L.n * p.k.hexes.length);
      for (let i = 0; i < ids.length; i++) ids[i] = b.mesh.addInstance(gid);
      p.k.leaves.push({ ...L, batch: b, ids });
    }
    // Shared materials go white once every source's colour is read; the batches colour each instance, the bakes each corner.
    for (const p of plans) if (!p.own) (p.o.material as THREE.MeshStandardMaterial).color?.setRGB(1, 1, 1);

    // The sprites: one draw for the added glows, one for the blended puffs.
    const groups = new Map<string, { list: typeof spritePlans; map: THREE.Texture | null; add: boolean; tm: boolean }>();
    for (const sp of spritePlans) {
      const m = sp.o.material;
      const add = m.blending === THREE.AdditiveBlending;
      const key = `${m.map?.uuid}|${add}|${m.toneMapped}`;
      const g = groups.get(key) ?? { list: [], map: m.map, add, tm: m.toneMapped };
      g.list.push(sp);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const total = g.list.reduce((a, sp) => a + sp.k.hexes.length, 0);
      const sb = new SpriteBatch(g.map, g.add, g.tm, total);
      for (const sp of g.list) {
        sp.k.sprites.push({ o: sp.o, sb, first: sb.count });
        sb.count += sp.k.hexes.length;
      }
      this.sprites.push(sb);
      this.group.add(sb.mesh);
    }
    return true;
  }

  // Bake static sources (one material's) into one mesh over every hex of their kind: each corner in world space, with its
  // colour, its hex's slot and the pivot and delay its thing squashes by in a roll.
  private async bake(plans: { k: Kind; o: THREE.Mesh; own: boolean; attrs: string[]; cast: boolean; plain: boolean }[], leaves: Omit<Leaf, "batch" | "ids">[], breathe: () => Promise<boolean>) {
    const p0 = plans[0]!;
    const src = p0.o.material as THREE.MeshStandardMaterial;
    const mat = p0.own ? src : copyMaterial(src);
    if (!p0.own) mat.color?.setRGB(1, 1, 1);
    if (p0.plain) sharePlain(mat);
    (mat as THREE.Material & { vertexColors: boolean }).vertexColors = true;
    hexPatch(mat, this.hexU);
    let nv = 0;
    let ni = 0;
    plans.forEach((p, i) => {
      const g = indexed(p.o.geometry);
      const c = leaves[i]!.n * p.k.hexes.length;
      nv += g.getAttribute("position").count * c;
      ni += g.index!.count * c;
    });
    const P = new Float32Array(nv * 3);
    const N = new Float32Array(nv * 3);
    const C = new Float32Array(nv * 3);
    const H = new Float32Array(nv);
    const V = new Float32Array(nv * 4);
    const X = p0.attrs.map((a) => ({ a, k: a === "uv" ? 2 : 1, arr: new Float32Array(nv * (a === "uv" ? 2 : 1)) }));
    const I = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    let v0 = 0;
    let i0 = 0;
    const W = new THREE.Matrix4();
    const NM = new THREE.Matrix3();
    const v = new THREE.Vector3();
    const piv = new THREE.Vector3();
    for (let li = 0; li < plans.length; li++) {
      if (!(await breathe())) return null;
      const p = plans[li]!;
      const L = leaves[li]!;
      const g = indexed(p.o.geometry);
      if (!g.getAttribute("normal")) g.computeVertexNormals();
      g.boundingSphere ?? g.computeBoundingSphere();
      const pos = g.getAttribute("position") as THREE.BufferAttribute;
      const nor = g.getAttribute("normal") as THREE.BufferAttribute;
      // Each source's own material says whether its vertex colours count (the shared draw reads them for everyone).
      const reads = !!(p.o.material as THREE.Material & { vertexColors: boolean }).vertexColors;
      const col = reads ? (g.getAttribute("color") as THREE.BufferAttribute | undefined) : undefined;
      const idx = g.index!;
      const ex = X.map((x) => g.getAttribute(x.a) as THREE.BufferAttribute | undefined);
      const im = p.o as THREE.InstancedMesh;
      for (const h of p.k.hexes)
        for (let j = 0; j < L.n; j++) {
          W.copy(h.T).multiply(p.o.matrixWorld);
          if (im.isInstancedMesh) {
            W.multiply(im.getMatrixAt(j, _m2));
            if (g.boundingSphere!.radius * W.getMaxScaleOnAxis() < SPECK) continue;
          }
          NM.getNormalMatrix(W);
          let delay = -1;
          if (im.isInstancedMesh && L.delay) {
            delay = L.delay[j]!;
            piv.setFromMatrixPosition(W);
          } else if (L.top && L.delay) {
            delay = L.delay[0]!;
            piv.setFromMatrixPosition(_m.copy(h.T).multiply(L.top.matrixWorld));
          }
          const base = L.base[j]!;
          for (let k = 0; k < pos.count; k++) {
            const o = v0 + k;
            v.fromBufferAttribute(pos, k).applyMatrix4(W).toArray(P, o * 3);
            v.fromBufferAttribute(nor, k).applyMatrix3(NM).normalize().toArray(N, o * 3);
            C[o * 3] = base.r * (col ? col.getX(k) : 1);
            C[o * 3 + 1] = base.g * (col ? col.getY(k) : 1);
            C[o * 3 + 2] = base.b * (col ? col.getZ(k) : 1);
            H[o] = h.slot;
            V[o * 4] = piv.x;
            V[o * 4 + 1] = piv.y;
            V[o * 4 + 2] = piv.z;
            V[o * 4 + 3] = delay;
            X.forEach((x, xi) => {
              for (let c = 0; c < x.k; c++) x.arr[o * x.k + c] = ex[xi]?.getComponent(k, c) ?? 0;
            });
          }
          for (let k = 0; k < idx.count; k++) I[i0 + k] = idx.getX(k) + v0;
          v0 += pos.count;
          i0 += idx.count;
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(P, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(N, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(C, 3));
    geo.setAttribute("aHex", new THREE.BufferAttribute(H, 1));
    geo.setAttribute("aPivot", new THREE.BufferAttribute(V, 4));
    for (const x of X) geo.setAttribute(x.a, new THREE.BufferAttribute(x.arr, x.k));
    geo.setIndex(new THREE.BufferAttribute(I, 1));
    // The specks left off leave the tail of the buffers unused.
    geo.setDrawRange(0, i0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.castShadow = plans.some((p) => p.cast);
    mesh.receiveShadow = plans.some((p) => p.o.receiveShadow);
    mesh.renderOrder = p0.o.renderOrder;
    mesh.userData.tris = i0 / 3;
    this.bakes.push(mesh);
    return mesh;
  }

  // The paying-hex glow on a hex this frame (the game times it: docs/design/dice.md).
  glow(id: string, level: number) {
    const e = this.byHex.get(id);
    if (e) e.h.glow = level;
  }

  // The roll payoff's jelly squash and ripple on these hexes, starting now.
  roll(ids: string[]) {
    for (const id of ids) {
      const e = this.byHex.get(id);
      if (e) e.h.rollAt = this.t;
    }
  }

  tap(id: string) {
    const e = this.byHex.get(id);
    if (e) e.h.tapAt = this.t;
  }

  // The wayfarer stands on this hex (or none): it dulls, the others clear.
  robber(id: string | null) {
    for (const { h } of this.byHex.values()) h.dullTo = h.id === id ? 1 : 0;
  }

  // Something is still playing out (a roll, a tap, a dulling): the loop should draw at full rate.
  busy() {
    for (const { h } of this.byHex.values()) if (this.t - h.rollAt < ROLL_S || this.t - h.tapAt < TAP_S || Math.abs(h.dull - h.dullTo) > 1e-3 || h.glow > 0) return true;
    return false;
  }

  // Advance every scene to time t (seconds) and copy what moved to its instances. `all` rewrites every instance; `snap` lands
  // the dulling at once (reduced motion).
  update(t: number, all = false, snap = false) {
    const dt = Math.max(0, t - this.t);
    this.t = t;
    // The board's age: a story that starts with the match (the ore's climber) counts from the first live frame. Not from
    // create()'s update(0, true) or a snap (the swap, reduced motion): those would pin the start to the renderer's clock.
    if (!all && !snap) this.t0 ??= t;
    for (const k of this.kinds) {
      k.tile.env.age = this.t0 === undefined ? 0 : t - this.t0;
      k.tile.update(t);
      k.tile.group.updateMatrixWorld(true);
      // The hex level: its squash (the roll's jelly wobble, a tap's smaller one) and its colour (flash, dulling).
      for (const h of k.hexes) {
        const ur = (t - h.rollAt) / ROLL_S;
        h.roll = ur >= 0 && ur <= 1 && h.dull < 0.5 ? ur : -1;
        const ut = (t - h.tapAt) / TAP_S;
        const kr = h.roll >= 0 ? Math.sin(h.roll * Math.PI * 4) * (1 - h.roll) ** 1.5 : 0;
        const kt = ut >= 0 && ut <= 1 ? 0.5 * Math.sin(ut * Math.PI * 3) * (1 - ut) ** 1.5 : 0;
        const kk = kr + kt;
        const was = h.dull;
        h.dull = snap ? h.dullTo : h.dull + (h.dullTo - h.dull) * Math.min(1, dt * 3);
        if (Math.abs(h.dull - h.dullTo) < 1e-3) h.dull = h.dullTo;
        const active = kk !== 0 || h.glow !== h.glowWas || h.dull !== was;
        h.glowWas = h.glow;
        // Rewritten while anything plays out, and once more after, to land back on rest.
        h.dirty = all || active || h.wasActive;
        h.wasActive = active;
        h.M.copy(h.T).multiply(_m.makeScale(1 - 0.03 * kk, 1 + 0.07 * kk, 1 - 0.03 * kk));
        h.fx.setRGB(1, 1, 1).lerp(DULL, h.dull);
        // The glow warms the hex toward its resource's light (the cap glow's 0.35 peak is about +60 % red).
        h.fx.r *= 1 + h.glow * 1.7;
        h.fx.g *= 1 + h.glow * 1.25;
        h.fx.b *= 1 + h.glow * 0.35;
        const a = this.hexU.uHexA.value[h.slot];
        if (a) {
          a.z = h.roll;
          a.w = kk;
          this.hexU.uHexT.value[h.slot]!.set(h.fx.r, h.fx.g, h.fx.b);
        }
      }
      for (const L of k.leaves) this.writeLeaf(k, L, all);
      for (const sp of k.sprites) this.writeSprite(k, sp);
    }
    for (const sb of this.sprites) {
      sb.mesh.instanceMatrix.needsUpdate = true;
      sb.color.needsUpdate = true;
    }
  }

  private writeLeaf(k: Kind, L: Leaf, all: boolean) {
    if (!L.batch) return;
    const root = k.tile.group;
    const mesh = L.batch.mesh;
    const im = L.o as THREE.InstancedMesh;
    const vis = visibleIn(L.o, root);
    const opacity = (L.o.material as THREE.Material).opacity;
    for (let hi = 0; hi < k.hexes.length; hi++) {
      const h = k.hexes[hi]!;
      if (!all && !L.moves && !L.alpha && !h.dirty) continue;
      // The ripple: a placed thing squashes about its own place, a crowd's instance about its own.
      let R: THREE.Matrix4 | null = null;
      if (h.roll >= 0 && L.top && L.delay) {
        const q = rippleQ(h.roll, L.delay[0]!);
        if (q) {
          _inv.copy(L.top.matrixWorld).invert();
          R = _q.copy(L.top.matrixWorld).multiply(_m2.makeScale(1 - 0.12 * q, 1 + 0.22 * q, 1 - 0.12 * q)).multiply(_inv);
        }
      }
      for (let j = 0; j < L.n; j++) {
        const id = L.ids[hi * L.n + j]!;
        if (!vis) {
          mesh.setVisibleAt(id, false);
          continue;
        }
        mesh.setVisibleAt(id, true);
        _m.copy(h.M);
        if (R) _m.multiply(R);
        _m.multiply(L.o.matrixWorld);
        if (im.isInstancedMesh) {
          im.getMatrixAt(j, _m2);
          _m.multiply(_m2);
          if (h.roll >= 0 && L.delay) {
            const q = rippleQ(h.roll, L.delay[j]!);
            if (q) _m.multiply(_m2.makeScale(1 - 0.1 * q, 1 + 0.18 * q, 1 - 0.1 * q));
          }
        }
        mesh.setMatrixAt(id, _m);
        const c = L.base[j]!;
        if (L.batch.rgba) mesh.setColorAt(id, _c4.set(c.r * h.fx.r, c.g * h.fx.g, c.b * h.fx.b, opacity));
        else mesh.setColorAt(id, _c.setRGB(c.r * h.fx.r, c.g * h.fx.g, c.b * h.fx.b));
      }
    }
  }

  private writeSprite(k: Kind, sp: SpriteLeaf) {
    const m = sp.o.material;
    const vis = visibleIn(sp.o, k.tile.group) && m.opacity > 0.002;
    const col = sp.sb.color.array as Float32Array;
    for (let hi = 0; hi < k.hexes.length; hi++) {
      const h = k.hexes[hi]!;
      const i = sp.first + hi;
      if (!vis) {
        col[i * 4 + 3] = 0;
        sp.sb.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
        continue;
      }
      sp.o.matrixWorld.decompose(_p, _rot, _s);
      _m.copy(h.M).multiply(sp.o.matrixWorld);
      _p.setFromMatrixPosition(_m);
      _m.compose(_p, _rot.identity(), _s);
      sp.sb.mesh.setMatrixAt(i, _m);
      col[i * 4] = m.color.r * h.fx.r;
      col[i * 4 + 1] = m.color.g * h.fx.g;
      col[i * 4 + 2] = m.color.b * h.fx.b;
      col[i * 4 + 3] = m.opacity;
    }
  }

  // For the proofs. The ground's height (world y) at a point of a hex, from the hex's centre.
  groundAt(id: string, dx: number, dz: number) {
    const e = this.byHex.get(id);
    return e ? e.h.T.elements[13]! + e.k.tile.ground(dx, dz) : NaN;
  }

  // For the proofs: per kind, how near to the hex's centre (horizontally) any corner of anything on it comes now, and what
  // that is. The block itself, water, fog and glows are not things standing on the hex.
  clearance(under = Infinity) {
    const out: Record<string, { min: number; what: string; all: Record<string, number> }> = {};
    const sph = new THREE.Sphere();
    const v = new THREE.Vector3();
    for (const k of this.kinds) {
      let min = Infinity;
      let what = "";
      const all: Record<string, number> = {};
      const [top, side] = k.tile.group.children;
      for (const L of k.leaves) {
        const mat = L.o.material as THREE.Material;
        if (L.o === top || L.o === side || mat.transparent || !visibleIn(L.o, k.tile.group)) continue;
        let ref = "";
        for (let q: THREE.Object3D | null = L.o; q && !ref; q = q.parent) ref = (q.userData.ref as string) ?? "";
        ref ||= `${mat.customProgramCacheKey()}#${k.leaves.indexOf(L)}`;
        const g = L.o.geometry;
        g.boundingSphere ?? g.computeBoundingSphere();
        const pos = g.getAttribute("position") as THREE.BufferAttribute;
        const im = L.o as THREE.InstancedMesh;
        for (let j = 0; j < L.n; j++) {
          _m.copy(L.o.matrixWorld);
          if (im.isInstancedMesh) _m.multiply(im.getMatrixAt(j, _m2));
          sph.copy(g.boundingSphere!).applyMatrix4(_m);
          if (Math.hypot(sph.center.x, sph.center.z) - sph.radius >= Math.max(min, under)) continue;
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(_m);
            // Fliers well over the hex (gulls, vultures) are not standing on it.
            if (v.y > BLOCK_H + 0.45) continue;
            const d = Math.hypot(v.x, v.z);
            if (d < under) all[ref] = Math.min(all[ref] ?? Infinity, +d.toFixed(3));
            if (d < min) {
              min = d;
              what = ref;
            }
          }
        }
      }
      out[k.kind] = { min, what, all };
    }
    return out;
  }

  // For the proofs: whether anything opaque in the scenes (landforms, buildings, trees, creatures) lies on the segment from a
  // to b, short of b by 0.01. Returns the nearest hit's point, hex kind and seed, or null when clear.
  occludes(a: THREE.Vector3, b: THREE.Vector3): OcclusionHit | null {
    const dir = b.clone().sub(a);
    const len = dir.length() - 0.01;
    dir.normalize();
    const ray = new THREE.Ray(a, dir);
    const [lo, hi] = [a.clone().min(b), a.clone().max(b)];
    const t0 = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), hit = new THREE.Vector3();
    let minDist = len;
    let closest: OcclusionHit | null = null;
    for (const m of this.bakes) {
      if ((m.material as THREE.Material).transparent) continue;
      const pos = m.geometry.getAttribute("position") as THREE.BufferAttribute;
      const aHex = m.geometry.getAttribute("aHex") as THREE.BufferAttribute | undefined;
      const idx = m.geometry.index!;
      const end = m.geometry.drawRange.count === Infinity ? idx.count : Math.min(idx.count, m.geometry.drawRange.count);
      for (let i = 0; i < end; i += 3) {
        t0.fromBufferAttribute(pos, idx.getX(i));
        t1.fromBufferAttribute(pos, idx.getX(i + 1));
        t2.fromBufferAttribute(pos, idx.getX(i + 2));
        if (Math.max(t0.x, t1.x, t2.x) < lo.x || Math.min(t0.x, t1.x, t2.x) > hi.x) continue;
        if (Math.max(t0.z, t1.z, t2.z) < lo.z || Math.min(t0.z, t1.z, t2.z) > hi.z) continue;
        if (Math.max(t0.y, t1.y, t2.y) < lo.y || Math.min(t0.y, t1.y, t2.y) > hi.y) continue;
        if (ray.intersectTriangle(t0, t1, t2, false, hit)) {
          const d = hit.distanceTo(a);
          if (d < minDist) {
            minDist = d;
            const slot = aHex ? aHex.getX(idx.getX(i)) : -1;
            let kind: Terrain = "waste", seed = 0;
            for (const k of this.kinds) for (const h of k.hexes) if (h.slot === slot) { kind = k.kind; seed = k.tile.layout.seed; }
            closest = { point: { x: hit.x, y: hit.y, z: hit.z }, kind, seed };
          }
        }
      }
    }
    const caster = new THREE.Raycaster(a, dir, 0, minDist);
    for (const bm of this.batches.values()) {
      if ((bm.mesh.material as THREE.Material).transparent) continue;
      for (const h of caster.intersectObject(bm.mesh, false)) {
        if (h.distance < minDist) {
          minDist = h.distance;
          caster.far = minDist;
          let kind: Terrain = "waste", seed = 0;
          for (const k of this.kinds)
            for (const L of k.leaves)
              if (L.batch === bm && L.ids.indexOf(h.batchId!) !== -1) { kind = k.kind; seed = k.tile.layout.seed; break; }
          closest = { point: { x: h.point.x, y: h.point.y, z: h.point.z }, kind, seed };
        }
      }
    }
    return closest;
  }

  // The jelly look never moves what it draws for the camera or the tokens: the context is accepted and ignored.
  setVisibilityContext(_context: VisibilityContext) {}

  // The jelly board's own numbers, with the common ones beside them (LandStats): what it owns is its batches, bakes and sprites.
  stats(): JellyStats & LandStats {
    let triangles = 0;
    for (const b of this.batches.values()) {
      const counts = new Map<number, number>();
      for (const k of this.kinds) for (const L of k.leaves) if (L.batch === b) counts.set(b.geos.get(L.o.geometry)!, (counts.get(b.geos.get(L.o.geometry)!) ?? 0) + L.ids.length);
      for (const [gid, n] of counts) triangles += b.tris.get(gid)! * n;
    }
    for (const m of this.bakes) triangles += m.userData.tris as number;
    for (const sb of this.sprites) triangles += 2 * sb.count;
    const draws = this.batches.size + this.bakes.length + this.sprites.length;
    return {
      lite: this.lite,
      drawCalls: draws,
      triangles: Math.round(triangles),
      kinds: this.kinds.length,
      batches: this.batches.size,
      bakes: this.bakes.length,
      sprites: this.sprites.length,
      quality: this.lite ? "lite" : "full",
      objects: { meshes: draws, geometries: draws, materials: draws },
    };
  }

  dispose() {
    for (const b of this.batches.values()) {
      b.mesh.dispose();
      (b.mesh.material as THREE.Material).dispose();
    }
    for (const m of this.bakes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.bakes = [];
    for (const sb of this.sprites) {
      sb.mesh.geometry.dispose();
      (sb.mesh.material as THREE.Material).dispose();
      sb.mesh.dispose();
    }
    for (const k of this.kinds)
      k.tile.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
      });
    this.group.clear();
    this.batches.clear();
    this.sprites = [];
    this.kinds = [];
    this.byHex.clear();
  }
}
