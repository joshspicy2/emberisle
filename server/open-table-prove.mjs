// Server proof for the open-table feature (#833).
// 1. An open table created with visibility:"open" appears in GET /tables and in the WS "list" response.
// 2. A private table (default, no visibility flag) never appears in the list.
// 3. The list never exposes a private table's code.
// 4. Joining via the listed code works — seat is granted without already knowing the code.
// 5. Once the open table's host drops, the room closes and the list empties.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createGame } from "../src/lib/game/board.ts";
import { chooseBotAction } from "../src/lib/game/ai.ts";
import { applyAction, totalVP } from "../src/lib/game/rules.ts";
import { getOpenTables, maybeReleaseOpenSlot, registerOpenTable, unregisterOpenTable } from "./open-table.mjs";

// A connected finished table must release its slot; an unrelated drop cannot remove its successor.
{
  const finished = { code: "OVER", host: "s0", seats: [{ id: "s0", name: "Winner", ws: {} }], game: { phase: "play" } };
  assert.equal(registerOpenTable(finished), true);
  assert.equal(getOpenTables()[0].status, "playing");
  finished.game.phase = "over";
  maybeReleaseOpenSlot(finished);
  assert.deepEqual(getOpenTables(), [], "game over releases the slot even with a connected host");
  const next = { ...finished, code: "NEXT", game: null };
  assert.equal(registerOpenTable(next), true, "a new open host can claim the finished table's slot");
  unregisterOpenTable(finished);
  assert.equal(getOpenTables()[0].code, "NEXT", "dropping the old room preserves the new listing");
  unregisterOpenTable(next);
}

const ROOMS_DIR = mkdtempSync(path.join(tmpdir(), "emberisle-open-table-"));
let host;
const sockets = [];
process.on("exit", () => {
  host?.kill("SIGKILL");
  for (const c of sockets) c.ws.terminate();
  rmSync(ROOMS_DIR, { recursive: true, force: true });
});
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(130));

function boot(env = {}) {
  host = spawn(process.execPath, ["--import", "./register.mjs", "host.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, PORT: "0", ROOMS_DIR, SAVE_MS: "9999999", ...env },
  });
  return new Promise((resolve, reject) => {
    host.stdout.on("data", (d) => {
      const m = String(d).match(/listening (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    host.on("exit", (c) => reject(new Error(`host exited ${c}`)));
  });
}

function client(port, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const c = { name, ws, inbox: [], waiters: [] };
  sockets.push(c);
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    c.inbox.push(msg);
    for (const w of c.waiters.splice(0)) w();
  });
  c.send = (msg) => ws.send(JSON.stringify(msg));
  c.next = async (type, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = c.inbox.findIndex((m) => m.type === type);
      if (i >= 0) return c.inbox.splice(i, 1)[0];
      if (Date.now() > end) throw new Error(`${name} waited for ${type}`);
      await new Promise((res) => { c.waiters.push(res); setTimeout(res, 50); });
    }
  };
  c.open = new Promise((res) => ws.on("open", res));
  return c;
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const port = await boot({ LOBBY_HOLD_MS: "1000" });
const baseUrl = `http://127.0.0.1:${port}`;

// 1. No open tables yet: GET /tables returns [].
{
  const res = await fetch(`${baseUrl}/tables`);
  assert.equal(res.status, 200);
  const tables = await res.json();
  assert.deepEqual(tables, [], "no open tables before anyone hosts");
}

// 2. A private table (default) never appears in the list.
{
  const priv = client(port, "Private-host");
  await priv.open;
  priv.send({ type: "hello", name: "Private-host" });
  const welcome = await priv.next("welcome");
  const privateCode = welcome.code;
  assert.ok(typeof privateCode === "string" && privateCode.length === 4, "host welcomed with code");

  const res = await fetch(`${baseUrl}/tables`);
  const tables = await res.json();
  assert.deepEqual(tables, [], "a private table does not appear in the list");

  // Also confirm via WS list message.
  const lister = client(port, "lister-1");
  await lister.open;
  lister.send({ type: "list" });
  const reply = await lister.next("openTables");
  assert.deepEqual(reply.tables, [], "WS list also returns [] for private-only host");

  // The private table's code never leaks.
  assert.ok(!JSON.stringify(reply.tables).includes(privateCode), "private code is never in the list");
  priv.ws.terminate();
  lister.ws.terminate();
}

await settle(300);

// 3. An open table appears in the list.
let openCode;
{
  const opn = client(port, "Jarrod");
  await opn.open;
  opn.send({ type: "hello", name: "Jarrod", visibility: "open" });
  const welcome = await opn.next("welcome");
  openCode = welcome.code;

  await settle(100);

  const res = await fetch(`${baseUrl}/tables`);
  const tables = await res.json();
  assert.equal(tables.length, 1, "one open table in the list");
  assert.equal(tables[0].code, openCode, "correct code");
  assert.equal(tables[0].name, "Jarrod's table");
  assert.equal(tables[0].seated, 1);
  assert.equal(tables[0].total, 4);
  assert.equal(tables[0].status, "lobby");

  // WS list message returns the same.
  const lister = client(port, "lister-2");
  await lister.open;
  lister.send({ type: "list" });
  const reply = await lister.next("openTables");
  assert.equal(reply.tables.length, 1, "WS list sees the open table");
  assert.equal(reply.tables[0].code, openCode);
  lister.ws.terminate();

  // At most one live table per host player (#944): the same player's second open create is refused.
  const rival = client(port, "Rival");
  await rival.open;
  rival.send({ type: "hello", name: "Rival", visibility: "open", hostSeats: [welcome.secret] });
  const err = await rival.next("error");
  assert.equal(err.message, "You're already hosting a table.", "the same player's second open table is refused");
  const still = await (await fetch(`${baseUrl}/tables`)).json();
  assert.equal(still.length, 1, "list still has only Jarrod's table");
  assert.equal(still[0].code, openCode);
  rival.ws.terminate();
}

// 4. A second player can join the open table using the listed code (no prior knowledge of the code).
{
  const joshua = client(port, "Joshua");
  await joshua.open;
  joshua.send({ type: "hello", code: openCode, name: "Joshua" });
  const welcome = await joshua.next("welcome");
  assert.equal(welcome.code, openCode, "Joshua joined with the code from the list");

  // Seated count reflects Joshua.
  await settle(150);
  const res = await fetch(`${baseUrl}/tables`);
  const tables = await res.json();
  assert.equal(tables[0].seated, 2, "seated count updated after a join");
  joshua.ws.terminate();
}

// 5. A private table hosted alongside the open one never appears in the list.
{
  await settle(5500); // refill GET /tables tokens so a 429 [] is not mistaken for "no open table"
  const priv2 = client(port, "Secret-host");
  await priv2.open;
  priv2.send({ type: "hello", name: "Secret-host" });
  await priv2.next("welcome");
  await settle(100);

  const res = await fetch(`${baseUrl}/tables`);
  assert.equal(res.status, 200, "GET /tables ok after refill");
  const tables = await res.json();
  assert.equal(tables.length, 1, "only the open table appears");
  assert.equal(tables[0].code, openCode, "the open table's code is listed, not the private one's");
  priv2.ws.terminate();
}

// 6. Host handoff updates the listed name; bots count toward seated.
{
  // Re-host after the earlier open table is still held by Jarrod+Joshua sockets from steps 3–4.
  // Close those first so the slot frees (no connected seats).
  sockets.find((c) => c.name === "Jarrod")?.ws.terminate();
  sockets.find((c) => c.name === "Joshua")?.ws.terminate();
  await settle(200);
  assert.deepEqual(await (await fetch(`${baseUrl}/tables`)).json(), [], "slot frees when nobody is connected");

  const hostA = client(port, "Ada");
  await hostA.open;
  hostA.send({ type: "hello", name: "Ada", visibility: "open" });
  const welcomeA = await hostA.next("welcome");
  const codeA = welcomeA.code;
  const guest = client(port, "Bea");
  await guest.open;
  guest.send({ type: "hello", code: codeA, name: "Bea" });
  await guest.next("welcome");
  // Host adds a bot: seated must be 3 (Ada, Bea, Bot), not 2.
  hostA.send({ type: "addBot" });
  await settle(150);
  let tables = await (await fetch(`${baseUrl}/tables`)).json();
  assert.equal(tables[0].seated, 3, "bots count toward seated");
  assert.equal(tables[0].name, "Ada's table");
  // Ada leaves: Bea becomes host; listed name follows the host seat.
  hostA.ws.terminate();
  await settle(200);
  tables = await (await fetch(`${baseUrl}/tables`)).json();
  assert.equal(tables[0]?.name, "Bea's table", "listed name follows host handoff");
  guest.ws.terminate();
  await settle(200);
}

// 7. GET /tables is rate-limited (429 after the burst).
{
  await settle(6000); // refill the shared bucket
  const statuses = [];
  for (let i = 0; i < 16; i++) {
    statuses.push((await fetch(`${baseUrl}/tables`)).status);
  }
  assert.ok(statuses.includes(429), `GET /tables is rate-limited (statuses ${statuses.join(",")})`);
  await settle(1200); // refill
  assert.equal((await fetch(`${baseUrl}/tables`)).status, 200, "GET /tables recovers after throttle");
}

// 8. When the open table's seats drop and the room closes, the list stays empty and a new open host can claim the slot.
{
  await settle(5500); // refill after the rate-limit burst
  const again = client(port, "Clara");
  await again.open;
  again.send({ type: "hello", name: "Clara", visibility: "open" });
  const saved = await again.next("welcome");
  const listed = await fetch(`${baseUrl}/tables`);
  assert.equal(listed.status, 200, "GET /tables ok when listing Clara");
  assert.equal((await listed.json())[0]?.name, "Clara's table");
  again.ws.terminate();
  await settle(100);
  const returning = client(port, "Clara-returning");
  await returning.open;
  returning.send({ type: "hello", code: saved.code, secret: saved.secret });
  await returning.next("welcome");
  const restored = await fetch(`${baseUrl}/tables`);
  assert.equal(restored.status, 200);
  assert.equal((await restored.json())[0]?.code, saved.code, "a held open seat restores its listing after reconnect");
  returning.ws.terminate();
  await settle(1200); // Wait for the held seat to expire.
  assert.deepEqual(await (await fetch(`${baseUrl}/tables`)).json(), [], "list empties when the open table is dropped");
}

// 9. Restart preserves open visibility; private and legacy snapshots remain unlisted.
{
  const stop = async (signal) => {
    const exited = new Promise((resolve) => host.once("exit", resolve));
    host.kill(signal);
    await exited;
  };
  await stop("SIGTERM");
  let restartPort = await boot({ SAVE_MS: "20", LOBBY_HOLD_MS: "10000" });
  const credentials = [];
  for (const [name, visibility] of [["Restart-open", "open"], ["Restart-private", "private"], ["Restart-legacy", "private"], ["Restart-invalid", "private"]]) {
    const c = client(restartPort, name);
    await c.open;
    c.send({ type: "hello", name, visibility });
    const saved = await c.next("welcome");
    credentials.push({ name, visibility, ...saved });
  }
  // Observe actual persisted snapshots before the crash; no fixed save-delay assumption.
  const deadline = Date.now() + 3000;
  for (const c of credentials) {
    let saved;
    while (Date.now() < deadline) {
      try { saved = JSON.parse(readFileSync(path.join(ROOMS_DIR, `${c.code}.json`), "utf8")); } catch {}
      if (saved?.visibility === c.visibility) break;
      await settle(20);
    }
    assert.equal(saved?.visibility, c.visibility, `${c.name} visibility is persisted before crash`);
  }
  await stop("SIGKILL");
  // Exercise old snapshots and invalid visibility values without turning either into a public table.
  for (const c of credentials.slice(2)) {
    const file = path.join(ROOMS_DIR, `${c.code}.json`);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (c.name === "Restart-legacy") delete saved.visibility;
    else saved.visibility = "OPEN";
    writeFileSync(file, JSON.stringify(saved));
  }
  const preSavedAt = new Map(credentials.map((c) => [c.code, JSON.parse(readFileSync(path.join(ROOMS_DIR, `${c.code}.json`), "utf8")).savedAt]));
  restartPort = await boot({ SAVE_MS: "20", LOBBY_HOLD_MS: "10000" });
  const lister = client(restartPort, "restart-observer");
  await lister.open;
  lister.send({ type: "list" });
  assert.deepEqual((await lister.next("openTables")).tables, [], "restored held seats stay unlisted until a player returns");
  // Rejoin private seats first: they must not take the single open slot.
  for (const c of [...credentials.slice(1), credentials[0]]) {
    const returning = client(restartPort, `${c.name}-returning`);
    await returning.open;
    returning.send({ type: "hello", code: c.code, secret: c.secret });
    const welcome = await returning.next("welcome");
    assert.equal(welcome.code, c.code, `${c.name} recovers the same table after restart`);
    // Use a fresh observer for each check, preserving pre-seat request limits.
    const observer = client(restartPort, `${c.name}-observer`);
    await observer.open;
    observer.send({ type: "list" });
    const tables = (await observer.next("openTables")).tables;
    if (c.visibility === "open") {
      assert.equal(tables.length, 1, "the open table reappears after restart and authenticated rejoin");
      assert.equal(tables[0].code, c.code);
      assert.equal(tables[0].name, "Restart-open's table");
    } else assert.deepEqual(tables, [], `${c.name} remains private after restart and authenticated rejoin`);
    observer.ws.terminate();

    // Inspect the actual rewritten room snapshot on disk after authenticated rejoin (#988).
    const file = path.join(ROOMS_DIR, `${c.code}.json`);
    let rewritten;
    const saveDeadline = Date.now() + 3000;
    while (Date.now() < saveDeadline) {
      try { rewritten = JSON.parse(readFileSync(file, "utf8")); } catch {}
      if (rewritten?.savedAt && rewritten.savedAt > (preSavedAt.get(c.code) ?? 0)) break;
      await settle(20);
    }
    assert.ok(rewritten?.savedAt && rewritten.savedAt > (preSavedAt.get(c.code) ?? 0), `${c.name} snapshot was rewritten after rejoin`);
    if (c.name === "Restart-invalid") {
      assert.equal(rewritten.visibility, "private", "invalid visibility persists as private after restart and authenticated rejoin");
    } else if (c.name === "Restart-legacy") {
      assert.equal(rewritten.visibility, "private", "missing visibility persists as private after restart and authenticated rejoin");
    } else if (c.visibility === "open") {
      assert.equal(rewritten.visibility, "open", "valid open visibility stays open after restart and authenticated rejoin");
    } else {
      assert.equal(rewritten.visibility, "private", "valid private visibility stays private after restart and authenticated rejoin");
    }
  }
  console.log("restart: open visibility persists through kill -9 and rejoin; private, missing and invalid visibility stay hidden");
}

// 10. Rejoin can finish a game through conservative recovery, while its reader stays connected.
{
  const stop = async () => {
    const exited = new Promise((resolve) => host.once("exit", resolve));
    host.kill("SIGKILL");
    await exited;
  };
  await stop();
  let game = createGame({ humans: [{ name: "Ember" }, { name: "Tide" }, { name: "Pine" }], bots: 0, seed: 55 });
  for (let i = 0; i < 40 && game.phase !== "roll"; i++) {
    const result = applyAction(game, game.current, chooseBotAction(game, game.current));
    assert.ifError(result.error);
    game = result.state;
  }
  assert.equal(game.phase, "roll", "recovery fixture completes real engine setup");
  game.phase = "main";
  game.current = "p0";
  game.players.sort((a, b) => a.id.localeCompare(b.id));
  game.victoryTarget = 7;
  // Off-turn points are checked as the next turn starts (rules.ts endTurn).
  const winner = game.players.find((p) => p.id === "p1");
  for (const v of game.vertices) {
    if (v.building?.playerId !== "p1") continue;
    v.building.kind = "stronghold";
    winner.strongholdsLeft -= 1;
    winner.outpostsLeft += 1;
  }
  winner.hidden.vp = game.victoryTarget - totalVP(game, "p1");
  assert.equal(winner.hidden.vp, 3, "fixture uses three points fortunes and two strongholds");
  for (let i = 0; i < winner.hidden.vp; i++) {
    const card = game.deck.indexOf("vp");
    assert.ok(card >= 0, "points fortune comes from the real deck");
    game.deck.splice(card, 1);
  }
  assert.equal(totalVP(game, "p1"), game.victoryTarget);
  game.players[0].kind = "bot";
  const terminal = applyAction(game, "p0", { type: "endTurn" });
  assert.ifError(terminal.error);
  assert.equal(terminal.state.phase, "over");
  assert.equal(terminal.state.winner, "p1");
  assert.equal(terminal.state.winReason.trigger, "turnStart");
  const seats = game.players.map((p, i) => ({ id: `s${i}`, name: p.name, color: p.color, ready: true, pid: p.id, secret: `recovery-${p.id}` }));
  writeFileSync(path.join(ROOMS_DIR, "RCVR.json"), JSON.stringify({
    code: "RCVR", host: "s1", next: 3, visibility: "open", recoveryPids: ["p0"],
    chat: [], chatSeq: 0, game, seats, shape: 2, savedAt: Date.now(),
  }));
  const recoveryPort = await boot();
  const returning = client(recoveryPort, "recovery-winner");
  await returning.open;
  returning.send({ type: "hello", code: "RCVR", secret: "recovery-p1" });
  await returning.next("welcome");
  const state = await returning.next("state");
  assert.equal(state.game.phase, "over", "rejoin publishes the recovery win");
  assert.equal(state.game.winner, "p1");
  assert.equal(returning.ws.readyState, WebSocket.OPEN, "winner remains connected during discovery check");
  const observer = client(recoveryPort, "terminal-observer");
  await observer.open;
  observer.send({ type: "list" });
  assert.deepEqual((await observer.next("openTables")).tables, [], "terminal recovery releases the slot even with its winner connected");
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${recoveryPort}/tables`)).json(), [], "HTTP discovery also omits the terminal recovery table");
  console.log("recovery: authenticated rejoin finishes at turn start and releases discovery while the winner stays connected");

  // #986: restored completed rooms must reclaim only a free open slot when rematched.
  for (const scenario of ["free", "successor", "private"]) {
    await stop();
    const visibility = scenario === "private" ? "private" : "open";
    const file = path.join(ROOMS_DIR, "RCVR.json");
    writeFileSync(file, JSON.stringify({
      code: "RCVR", host: "s1", next: 3, visibility, recoveryPids: [],
      chat: [], chatSeq: 0, game: terminal.state, seats, shape: 2, savedAt: Date.now(),
    }));
    const rematchPort = await boot({ SAVE_MS: "20" });
    const players = [];
    for (const seat of seats) {
      const c = client(rematchPort, `${scenario}-${seat.name}`);
      await c.open;
      c.send({ type: "hello", code: "RCVR", secret: seat.secret });
      assert.equal((await c.next("welcome")).code, "RCVR", "rematch seat authenticates into the restored room");
      assert.equal((await c.next("state")).game.phase, "over", "fixture restores a genuinely completed game");
      players.push(c);
    }
    const list = async () => {
      const c = client(rematchPort, `${scenario}-observer`);
      await c.open;
      c.send({ type: "list" });
      const tables = (await c.next("openTables")).tables;
      c.ws.terminate();
      return tables;
    };
    assert.deepEqual(await list(), [], "completed room stays unlisted before rematch");
    let successorCode;
    if (scenario === "successor") {
      const successor = client(rematchPort, "Successor");
      await successor.open;
      successor.send({ type: "hello", name: "Successor", visibility: "open" });
      successorCode = (await successor.next("welcome")).code;
      assert.equal((await list())[0]?.code, successorCode, "another host claims the released slot");
    }
    for (const c of players) c.inbox = c.inbox.filter((m) => m.type !== "state");
    players[1].send({ type: "again" });
    const rematches = await Promise.all(players.map((c) => c.next("state")));
    for (const state of rematches) {
      assert.notEqual(state.game.phase, "over", "every authenticated player receives the new game");
      assert.deepEqual(state.game.players.map((p) => ({ name: p.name, color: p.color })),
        [seats[1], seats[0], seats[2]].map((p) => ({ name: p.name, color: p.color })),
        "winner goes first; remaining seat order and colors survive rematch");
    }
    const tables = await list();
    // #944: open tables are no longer a single host-wide slot, so an open rematch is listed beside its successor.
    const rematchEntry = { code: "RCVR", status: "playing", seated: 3, total: 4 };
    const successorEntry = { code: successorCode, status: "lobby", seated: 1, total: 4 };
    const expected = scenario === "free" ? [rematchEntry] : scenario === "successor" ? [rematchEntry, successorEntry] : [];
    if (expected.length) {
      assert.equal(tables.length, expected.length, "exactly the open rematch and any successor are listed");
      for (const want of expected) {
        const got = tables.find((t) => t.code === want.code);
        assert.equal(got?.code, want.code, "rematch is listed again without replacing its successor");
        assert.equal(got.status, want.status);
        assert.equal(got.seated, want.seated, "listing counts exactly the rematch or successor seats");
        assert.equal(got.total, 4, "the listed capacity stays four");
      }
    } else assert.deepEqual(tables, [], "private rematch never becomes discoverable");
    const http = await fetch(`http://127.0.0.1:${rematchPort}/tables`);
    assert.equal(http.status, 200, "HTTP listing succeeds without masking the result with rate limiting");
    assert.deepEqual(await http.json(), tables, "HTTP and WS discovery agree after rematch");
    let saved;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      saved = JSON.parse(readFileSync(file, "utf8"));
      if (saved.game.phase !== "over" && saved.roster) break;
      await settle(20);
    }
    assert.equal(saved.roster?.v, 1, "rematch saves a new frozen roster");
    assert.match(saved.roster.gameId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(saved.roster.players, [seats[1], seats[0], seats[2]].map((s, i) => ({
      pid: `p${i}`, seat: s.id, profileId: null, name: s.name, color: s.color, kind: "human",
    })), "new frozen roster preserves seat attribution, names, colors and guest identities");
    console.log(`rematch ${scenario}: authenticated seats, winner order, frozen roster and guarded HTTP/WS discovery pass`);
  }

}

console.log("open-table-prove ok: list empty, private never listed, open listed, join via code, parallel private hidden, handoff, bots count, rate limit, cleanup on drop");
process.exit(0);
