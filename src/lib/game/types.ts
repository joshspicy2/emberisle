export const RESOURCES = ["timber", "clay", "wool", "grain", "ore"] as const;
export type Resource = (typeof RESOURCES)[number];
export type Terrain = Resource | "waste";
export type HarborKind = Resource | "any";
export type DevKind = "knight" | "road" | "plenty" | "monopoly" | "vp";
export type Phase =
  | "rollOff"
  | "setupSettle"
  | "setupRoad"
  | "roll"
  | "discard"
  | "robber"
  | "main"
  | "over";

export type PlayerKind = "human" | "bot";

export const RESOURCE_LABEL: Record<Resource, string> = {
  timber: "Wood",
  clay: "Brick",
  wool: "Sheep",
  grain: "Wheat",
  ore: "Stone",
};

export const TERRAIN_LABEL: Record<Terrain, string> = {
  timber: "Forest",
  clay: "Hills",
  wool: "Pasture",
  grain: "Fields",
  ore: "Mountains",
  waste: "Wastes",
};

export const PLAYER_COLORS = ["#e23d2e", "#2d6ee8", "#f3ecd9", "#8a4fd3"] as const;
export const PLAYER_NAMES = ["Ember", "Tide", "Dune", "Pine"] as const;

export const COST = {
  path: { timber: 1, clay: 1 } as Partial<Record<Resource, number>>,
  outpost: { timber: 1, clay: 1, wool: 1, grain: 1 } as Partial<Record<Resource, number>>,
  stronghold: { grain: 3, ore: 2 } as Partial<Record<Resource, number>>,
  card: { wool: 1, grain: 1, ore: 1 } as Partial<Record<Resource, number>>,
};

// What a piece and each award is worth, and the win line; rules.ts scores with these and the Costs card shows them.
// SeatRail and WinScreen count `p.hidden.vp` raw (one per points fortune), so they stay right only while pointsFortune is 1.
export const POINTS = { outpost: 1, stronghold: 2, longestPath: 2, largestArmy: 2, pointsFortune: 1, win: 10 } as const;
export const LONGEST_PATH_MIN = 5;
export const LARGEST_ARMY_MIN = 3;

export interface HexCell {
  id: string;
  q: number;
  r: number;
  terrain: Terrain;
  pip: number | null;
  blocked: boolean;
}

export interface Vertex {
  id: string;
  x: number;
  z: number;
  hexes: string[];
  building: { playerId: string; kind: "outpost" | "stronghold" } | null;
  harbor: HarborKind | null;
}

export interface Edge {
  id: string;
  va: string;
  vb: string;
  path: string | null;
}

export interface PlayerState {
  id: string;
  name: string;
  color: string;
  kind: PlayerKind;
  // Online, the host sends other players' `resources` as `goods` (the card count) and their
  // `hidden` fortunes as `fortunes` (the count); only your own hand arrives in full.
  resources: Record<Resource, number>;
  goods?: number;
  fortunes?: number;
  hidden: Record<DevKind, number>;
  // Fortunes drawn during this player's current turn; they cannot be played until a later turn.
  boughtThisTurn: Record<DevKind, number>;
  knightsPlayed: number;
  // Goods this seat lost to successful wayfarer steals (#550); absent reads as 0. Online the host keeps it out of every
  // view until the game is won, then sends it to every seat and watcher with the rest of the final state (server/host.mjs).
  goodsLost?: number;
  pathsLeft: number;
  outpostsLeft: number;
  strongholdsLeft: number;
}

export interface TradeOffer {
  from: string;
  to: string;
  give: Partial<Record<Resource, number>>;
  want: Partial<Record<Resource, number>>;
}

export type WayfarerMode = "on" | "off";
export type VictoryTarget = 7 | 10;
// #1156: how the number tokens are dealt (the generator's `numberTokens` option); an online table's match setting.
export type NumberTokens = "official" | "random";
export type WinTrigger = "outpost" | "stronghold" | "longestPath" | "largestArmy" | "pointFortune" | "turnStart" | "points";

export interface GameState {
  // Legacy saves use classic On. Fixed when the table is created.
  wayfarerMode?: WayfarerMode;
  seed: number;
  rng: number;
  seq: number;
  hexes: HexCell[];
  vertices: Vertex[];
  edges: Edge[];
  robberHex: string;
  players: PlayerState[];
  current: string;
  phase: Phase;
  turn: number;
  dice: [number, number] | null;
  // Pre-setup roll-off (docs/design/first-player.md): the die on each seat, and who still rolls this round.
  // `first` is a rematch's last winner (#266): it places first without rolling, and the rest roll off behind it.
  rollOff: { rolls: Record<string, number>; pending: string[]; first?: string } | null;
  setupIndex: number;
  lastSetupVertex: string | null;
  longestRoad: string | null;
  largestArmy: string | null;
  winner: string | null;
  // Optional for existing saves; absent means the standard ten-point game.
  victoryTarget?: VictoryTarget;
  // Written only when the game ends, then persisted with the final state.
  winReason?: { trigger: WinTrigger; points: number; target: VictoryTarget };
  bank: Record<Resource, number>;
  deck: DevKind[];
  // Online the host hides the deck order and sends only its size (server/host.mjs).
  deckLeft?: number;
  trade: TradeOffer | null;
  log: string[];
  discardNeeded: Record<string, number>;
  playedCard: boolean;
  // Dice rolls so far (not the roll-off) and what the latest one paid, per hex; a missing field in an old save reads as none.
  rolls?: number;
  lastProduction?: { hex: string; player: string; res: Resource; n: number; vertex?: string }[];
  hostId: string;
}

export type Action =
  | { type: "setupSettle"; vertexId: string }
  | { type: "setupRoad"; edgeId: string }
  | { type: "roll" }
  | { type: "discard"; resources: Partial<Record<Resource, number>> }
  | { type: "moveRobber"; hexId: string; stealFrom: string | null }
  | { type: "buildPath"; edgeId: string }
  | { type: "buildOutpost"; vertexId: string }
  | { type: "buildStronghold"; vertexId: string }
  | { type: "buyCard" }
  | { type: "playKnight"; hexId: string; stealFrom: string | null }
  | { type: "playRoad"; edgeIds: string[] }
  | { type: "playPlenty"; resources: Resource[] }
  | { type: "playMonopoly"; resource: Resource }
  | { type: "bankTrade"; give: Resource; want: Resource }
  | { type: "offerTrade"; to: string; give: Partial<Record<Resource, number>>; want: Partial<Record<Resource, number>> }
  | { type: "respondTrade"; accept: boolean }
  | { type: "endTurn" };

export type BuildMode = "none" | "path" | "outpost" | "stronghold" | "robber" | "knight" | "roadCard";
