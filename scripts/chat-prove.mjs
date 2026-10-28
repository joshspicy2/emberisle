// #899 (Chat C): one chat button, a panel with two tabs (Chat with the six emoji, Sounds & stickers with ten chips and the
// sticker), seat bubbles beside the card and never on the name (lobby, rail and strip), closed-chat line bubbles, the #895
// lobby hit test at 1280x720, a phone sheet that leaves the strip and its bubbles clear, and reduced motion.
// #160: three headless tabs at 1280x720 chat through server/host.mjs. Lobby chat, a floating reaction,
// the unread badge and the remembered open/minimized state, a minimized dock that covers no board target, the player action
// menu in the rail and under the phone seat strip (#161), the game log in the dock and Copy log in the Table menu (#305, #899),
// the lobby status line as seats join and ready up (#418), Start and Leave inside the 1280x720 lobby card (#417),
// #460: computed glass surfaces, 12 px controls, one primary and >= 4.5:1 text contrast over black, on desktop and phone,
// including the emoji, the sound chips, copy fallback and read-only chat. Zero console errors.
// #467: board reactions, all six emoji, image delivery, keyboard/cooldown, coalescing, reduced motion and host rejection.
// #477, #899: Open chat (the one chat button) sits in the top row beside the Table menu: at 390x844, 360x640 and 844x390 with notch insets, on
// an own Roll turn and another seat's turn, it is whole, in the safe area, clear of the menu and status, 12 px from every board target.
// Design: docs/design/chat.md "Test plan". Screenshots go to test-results/.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const PORT = Number(process.env.VITE_PORT) || 8094;
const SHOTS = fileURLToPath(new URL("../test-results/", import.meta.url));
const HUD_STACK = ".pointer-events-none.absolute.bottom-0.inset-x-0.z-10 > .relative > .overflow-y-auto";
mkdirSync(SHOTS, { recursive: true });

// Rooms go to a temp folder, dropped on exit, so the real host never restores this proof's tables (#207).
const ROOMS_DIR = mkdtempSync(path.join(tmpdir(), "emberisle-rooms-"));
process.on("exit", () => rmSync(ROOMS_DIR, { recursive: true, force: true }));
const host = spawn(process.execPath, ["--import", "./register.mjs", "host.mjs"], {
  cwd: new URL("../server/", import.meta.url),
  env: { ...process.env, PORT: "0", ROOMS_DIR },
});
process.on("exit", () => host.kill());
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(130));
const hostPort = await new Promise((resolve) =>
  host.stdout.on("data", (d) => {
    const m = String(d).match(/listening (\d+)/);
    if (m) resolve(Number(m[1]));
  }),
);
const vite = await createServer({ server: { host: "127.0.0.1", port: PORT, strictPort: true }, logLevel: "error" });
await vite.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
});

const T0 = Date.now();
const errors = [];
let code = 0;
const url = `http://127.0.0.1:${PORT}/?host=ws://127.0.0.1:${hostPort}`;

function watch(name, page) {
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${name}: ${e}`));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${name}: ${r.status()} ${r.url()}`));
}

// `phone` is a 390x844 touch phone (#178), the same device as scripts/mobile-shots.mjs.
async function tab(name, phone = false) {
  const ctx = await browser.newContext(
    phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 } : { viewport: { width: 1280, height: 720 } },
  );
  const page = await ctx.newPage();
  watch(name, page);
  await page.addInitScript((n) => localStorage.setItem("emberisle-name", n), name);
  // The phone remembers an open chat, and Play must still start with the sheet closed.
  if (phone) await page.addInitScript(() => localStorage.setItem("emberisle-chat-open", "1"));
  // Three software-rendered 1280x720 scenes starve the machine, and the proof reads the DOM. Skip GL draws except while a screenshot is taken.
  await page.addInitScript(() => {
    window.__draw = false;
    for (const fn of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"]) {
      const orig = WebGL2RenderingContext.prototype[fn];
      WebGL2RenderingContext.prototype[fn] = function (...args) {
        if (window.__draw) return orig.apply(this, args);
      };
    }
  });
  await page.goto(url);
  return { name, page };
}

async function until(check, what, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const got = await check();
    if (got) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out: ${what}`);
}

const store = (t, fn) => t.page.evaluate(fn);
// Capture after actual rendered frames, including the lazy island's first mount.
async function shot(t, file) {
  await t.page.waitForFunction(() => Boolean(window.__isle));
  const before = await t.page.evaluate(() => {
    window.__draw = true;
    return window.__isle.renders;
  });
  await t.page.waitForFunction((n) => window.__isle.renders >= n + 2, before, { timeout: 15_000 });
  await t.page.screenshot({ path: `${SHOTS}${file}`, type: "jpeg", quality: 70 });
  await t.page.evaluate(() => (window.__draw = false));
}
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`ok ${what}`, `+${((Date.now() - T0) / 1000).toFixed(1)}s`);
};

// #1129: the five newest stickers and the two newest soundboard chips are all on the open Sounds & stickers tab at this size: each
// sticker's image has loaded, each button scrolls fully into the viewport, and no sticker or chip is under 32 px (the existing sticker size on a mouse; the touch sizes are checked by the chip lines above).
// With PROOF_SHOTS set, a screenshot of the tab goes to that folder.
const NEW_STICKERS = ["monkey-pet", "side-eye", "banana-guy", "glasses-glance", "dark-smile"];
const NEW_CHIPS = ["Play sound Real badman", "Play sound Gong"];
async function newContent(t, size) {
  for (const id of NEW_STICKERS) {
    const button = t.page.getByTestId("stickers").getByRole("button", { name: `React ${id}`, exact: true });
    await button.scrollIntoViewIfNeeded();
    const m = await button.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const img = el.querySelector("img");
      return { loaded: Boolean(img && img.complete && img.naturalWidth > 0), inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, w: r.width, h: r.height };
    });
    check(m.loaded && m.inView && m.w >= 32 - 0.5 && m.h >= 32 - 0.5, `${size}: sticker ${id} is in the Sounds & stickers tab, loaded, on screen, ${m.w.toFixed(0)}x${m.h.toFixed(0)}`);
  }
  for (const name of NEW_CHIPS) {
    const chip = t.page.getByTestId("soundboard").getByRole("button", { name, exact: true });
    await chip.scrollIntoViewIfNeeded();
    const m = await chip.evaluate((el) => { const r = el.getBoundingClientRect(); return { inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, h: r.height }; });
    check(m.inView && m.h >= 32 - 0.5, `${size}: chip "${name}" is on screen at ${m.h.toFixed(0)} px tall`);
  }
  if (process.env.PROOF_SHOTS) {
    await t.page.getByTestId("stickers").scrollIntoViewIfNeeded();
    await t.page.screenshot({ path: `${process.env.PROOF_SHOTS}/stickers-${size}.png` });
  }
}

// Accumulate the style failures so a main run reports both viewports, rather than stopping at the first 8 px corner.
const polishFailures = [];
async function polish(t, state, selector = 'section[aria-label="Table chat"]', minControls = 1) {
  await t.page.locator(selector).first().waitFor();
  const result = await t.page.evaluate(({ selector, minControls }) => {
    const roots = [...document.querySelectorAll(selector)];
    const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const px = (css, under = "#000") => {
      canvas.fillStyle = under;
      canvas.fillRect(0, 0, 1, 1);
      canvas.fillStyle = css;
      canvas.fillRect(0, 0, 1, 1);
      return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const theme = getComputedStyle(document.documentElement);
    const glassCSS = theme.getPropertyValue("--color-glass").trim();
    if (!glassCSS) throw new Error("the glass token is missing");
    const glass = px(glassCSS);
    // Comparing over both black and white detects alpha differences as well as different RGB colours.
    const same = (a, b) => ["#000", "#fff"].every((under) => px(a, under).every((n, i) => Math.abs(n - px(b, under)[i]) <= 1));
    const lum = (rgb) => rgb.map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const visible = (el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && !el.closest(".sr-only");
    const name = (el) => el.getAttribute("aria-label") || el.textContent.trim().slice(0, 35) || el.tagName.toLowerCase();
    const bad = { corners: [], glass: [], contrast: [], primary: [] };
    const controls = roots.flatMap((root) => [
      ...(root.matches("button,input,textarea") ? [root] : []),
      ...root.querySelectorAll("button,input,textarea"),
    ]).filter(visible);
    if (controls.length < minControls) bad.corners.push(`expected at least ${minControls} controls, found ${controls.length}`);
    const pills = new Set(["Chat", "All", "Copy log", "Copied", "gg", "nice roll", "your turn", "one sec", "ty"]);
    const fg = theme.getPropertyValue("--color-fg").trim();
    const filled = [];
    for (const el of controls) {
      const css = getComputedStyle(el);
      const label = name(el);
      const radii = ["TopLeft", "TopRight", "BottomLeft", "BottomRight"].map((corner) => parseFloat(css[`border${corner}Radius`]));
      const pill = pills.has(el.textContent.trim());
      if (!radii.every((r) => Math.abs(r - 8) <= 0.01)) {
        bad.corners.push(`${label}: ${radii.join("/")} px${pill ? " (pill)" : ", want 12"}`);
      }
      const send = el.tagName === "BUTTON" && el.textContent.trim() === "Send";
      if (!same(css.backgroundColor, send ? fg : glassCSS)) bad.glass.push(`${label}: ${css.backgroundColor}`);
      if (["Top", "Right", "Bottom", "Left"].some((edge) => parseFloat(css[`border${edge}Width`]) !== 0)) bad.glass.push(`${label}: has a border`);
      if (el.tagName === "BUTTON" && same(css.backgroundColor, fg)) filled.push(label);
    }
    // Send is the deliberate primary exception to the glass controls. Spectators and minimized chat have no primary.
    const sends = controls.filter((el) => el.tagName === "BUTTON" && el.textContent.trim() === "Send").length;
    if (filled.length !== sends || filled.some((label) => label !== "Send")) bad.primary.push(`filled buttons: ${JSON.stringify(filled)}`);
    for (const root of roots) {
      if (!same(getComputedStyle(root).backgroundColor, glassCSS)) bad.glass.push(`${name(root)} surface: ${getComputedStyle(root).backgroundColor}`);
    }
    const texts = [];
    const measure = (el, text, css = getComputedStyle(el)) => {
      if (!text.trim() || !visible(el)) return;
      // Use one glass over black even inside the layered dock. Primary text, the unread badge and mentions have their
      // own backing; checking white badge/Send text against glass would report a false failure.
      const send = el.closest("button")?.textContent.trim() === "Send";
      const badge = el.closest('[data-testid="chat-unread"]');
      const mark = el.closest("mark");
      const backing = send ? fg : badge ? getComputedStyle(badge).backgroundColor : mark ? getComputedStyle(mark).backgroundColor : null;
      const bg = backing ? px(backing, `rgb(${glass.join(" ")})`) : glass;
      let ink = px(css.color, `rgb(${bg.join(" ")})`);
      const opacity = Number(css.opacity);
      ink = ink.map((n, i) => n * opacity + bg[i] * (1 - opacity));
      const contrast = ratio(ink, bg);
      texts.push(contrast);
      if (contrast < 4.5) bad.contrast.push(`${text.trim().slice(0, 30)}: ${contrast.toFixed(2)}:1`);
    };
    for (const root of roots) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) measure(walk.currentNode.parentElement, walk.currentNode.textContent);
    }
    for (const el of controls) {
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        measure(el, el.value || el.placeholder, el.value ? getComputedStyle(el) : getComputedStyle(el, "::placeholder"));
      }
    }
    return { bad, controls: controls.length, texts: texts.length, min: texts.length ? Math.min(...texts).toFixed(2) : "n/a", glass, viewport: `${innerWidth}x${innerHeight}` };
  }, { selector, minControls });
  for (const [kind, failures] of Object.entries(result.bad)) {
    if (failures.length) polishFailures.push(`${result.viewport} ${state} ${kind}: ${failures.join("; ")}`);
  }
  console.log(`${Object.values(result.bad).some((failures) => failures.length) ? "FAIL" : "ok"} chat polish ${result.viewport} ${state}: ${result.controls} controls, ${result.texts} texts, minimum ${result.min}:1, glass over black rgb(${result.glass})`);
}

// The chat log as a person sees it: how many whole lines are on screen (not clipped by the card or covered by the sticky row),
// whether the newest is one of them, and the text size.
const logView = (t) => t.page.evaluate(() => {
  const log = document.querySelector('[data-testid="chat-log"]');
  const box = log.getBoundingClientRect();
  const lines = [...log.querySelectorAll("li")];
  const shown = (li) => {
    const r = li.getBoundingClientRect();
    if (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5 || r.top < 0 || r.bottom > innerHeight) return false;
    const hit = document.elementFromPoint(r.left + Math.min(12, r.width / 2), r.top + r.height / 2);
    return Boolean(hit && li.contains(hit));
  };
  const last = lines.at(-1);
  return {
    total: lines.length,
    whole: lines.filter(shown).length,
    newest: Boolean(last && shown(last)),
    newestText: last?.textContent ?? "",
    font: last ? parseFloat(getComputedStyle(last).fontSize) : 0,
    size: `${innerWidth}x${innerHeight}`,
  };
});
// The rect the map is fitted to: if opening the chat refit the map, these change.
const hole = (t) => t.page.evaluate(() => {
  const el = document.querySelector("canvas")?.parentElement;
  return ["top", "right", "bottom", "left"].map((k) => el?.style.getPropertyValue(`--hole-${k}`)).join();
});
// The host allows a burst of five chat lines, then one a second, so lines are sent 700 ms apart.
const SAY = async (t, text) => {
  await t.page.evaluate((x) => window.__emberisle.getState().sendChat(x), text);
  await new Promise((r) => setTimeout(r, 700));
};

// #899 (Chat C): the one chat button opens the panel, whose Chat tab has the six emoji right above the input.
const openChat = async (t) => {
  if (!(await store(t, () => window.__emberisle.getState().chatOpen))) await t.page.getByRole("button", { name: /^Open chat/ }).click();
  await t.page.getByTestId("emoji-row").waitFor();
  await t.page.waitForFunction(() => !document.querySelector('[data-testid="emoji-row"] button')?.disabled);
};
const closeChat = async (t) => {
  if (await store(t, () => window.__emberisle.getState().chatOpen)) await t.page.getByRole("button", { name: "Minimize chat" }).click();
  await t.page.getByRole("button", { name: /^Open chat/ }).waitFor();
};
const showTab = async (t, name) => {
  await t.page.getByRole("tab", { name, exact: true }).click();
  await t.page.getByRole("tab", { name, exact: true, selected: true }).waitFor();
};
// A bubble (its visible box, the inner element) must not cross the name it belongs to, at any width.
const clearOfName = (t, anchor) =>
  t.page.getByTestId(anchor).evaluate((card) => {
    const bubble = card.querySelector("[data-seat-bubble] > div");
    const names = [...card.querySelectorAll('[data-testid="seat-name"], [data-testid="lobby-name"]')].filter((el) => el.getClientRects().length && !el.closest(".sr-only") && el.getBoundingClientRect().width > 1);
    if (!bubble || !names.length) return { ok: false, why: `bubble ${!!bubble}, names ${names.length}` };
    const b = bubble.getBoundingClientRect();
    const hit = names.find((el) => { const n = el.getBoundingClientRect(); return b.right > n.left && b.left < n.right && b.bottom > n.top && b.top < n.bottom; });
    return { ok: !hit, why: hit ? `bubble ${JSON.stringify(b)} crosses name ${JSON.stringify(hit.getBoundingClientRect())}` : "" };
  });

async function quickReactions(a, b, c, phone) {
  const choices = [["😠", "angry"], ["😊", "happy"], ["👏", "clap"], ["😂", "laugh"], ["🔥", "fire"], ["🐑", "sheep"]];
  // Preserve incoming events beyond their two-second UI lifetime, including any forbidden host broadcast.
  await b.page.evaluate(() => {
    window.__reactionProofReceived = [];
    window.__reactionProofUnsubscribe = window.__emberisle.subscribe((next, previous) => {
      window.__reactionProofReceived.push(...next.reactions.filter((r) => !previous.reactions.includes(r)));
    });
  });
  const identity = (t) => store(t, () => ({ seat: window.__emberisle.getState().seatId, player: window.__emberisle.getState().localId }));
  const receivedCount = () => b.page.evaluate(() => window.__reactionProofReceived.length);
  const delivered = async (t, emote, before) => {
    const { seat } = await identity(t);
    await b.page.waitForFunction(({ seat, emote, before }) => window.__reactionProofReceived.slice(before).some((r) => r.seat === seat && r.emote === emote), { seat, emote, before });
    check(true, `quick reactions: ${emote} from ${t.name} reaches another seat through the host`);
  };
  await a.page.evaluate(() => window.__emberisle.getState().setBuildMode("path"));
  await openChat(a);
  await a.page.getByPlaceholder("Say something…").focus();
  await a.page.keyboard.press("Escape");
  await a.page.getByRole("button", { name: /^Open chat/ }).waitFor();
  check(await store(a, () => window.__emberisle.getState().buildMode === "path"), "chat panel: first Escape (from the input) minimizes chat and keeps Path armed");
  await a.page.keyboard.press("Escape");
  check(await store(a, () => window.__emberisle.getState().buildMode === "none"), "chat panel: second Escape disarms Path");
  for (const t of [a, phone]) {
    check(await t.page.getByRole("button", { name: "Quick reactions" }).count() === 0, `chat panel: ${t.name} has no separate quick-reaction button`);
    check(await store(t, () => !window.__emberisle.getState().chatOpen), `chat panel: ${t.name} starts with chat closed`);
    if (t === phone) {
      check(await t.page.getByRole("button", { name: /^Open chat/ }).evaluate((button) => {
        const hint = document.querySelector('[data-testid="landscape-hint"]');
        if (!hint) return true;
        const a = button.getBoundingClientRect();
        const b = hint.getBoundingClientRect();
        return a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;
      }), "chat panel: phone Open chat leaves the rotate hint unobscured");
    }
    await openChat(t);
    check(await t.page.getByRole("tab", { name: "Chat", exact: true, selected: true }).count() === 1, `chat panel: ${t.name} opens on the Chat tab`);
    for (const [, label] of choices) await t.page.getByTestId("emoji-row").getByRole("button", { name: `React ${label}`, exact: true }).waitFor();
    check(await t.page.locator('section[aria-label="Table chat"] button[aria-label="Soundboard"], section[aria-label="Table chat"] button[aria-label="Emotes"]').count() === 0, `chat panel: ${t.name} has no speaker or smile toggle in the chat box`);
    await polish(t, "chat tab", 'section[aria-label="Table chat"]', 12);
    const fits = await t.page.getByTestId("emoji-row").evaluate((root) => {
      const input = document.getElementById("chat-input").getBoundingClientRect();
      const buttons = [...root.querySelectorAll("button")];
      return buttons.length === 6 && buttons.every((button) => {
        const r = button.getBoundingClientRect();
        return r.width >= 44 && r.height >= 44 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.bottom <= input.top && input.top - r.bottom <= 12;
      });
    });
    check(fits, `chat panel: ${t.name} has the six 44 px emoji in the viewport, right above the input`);
    await shot(t, t === phone ? "reactions-phone.jpg" : "reactions-desktop.jpg");
    await closeChat(t);
  }
  // Tab 1 sends each of the six emoji in one tap, and the panel stays open; a sent emoji rests the row for the cooldown.
  await openChat(a);
  for (const [index, [emoji, label]] of choices.entries()) {
    await a.page.waitForFunction(() => !document.querySelector('[data-testid="emoji-row"] button')?.disabled);
    const before = await receivedCount();
    await a.page.getByTestId("emoji-row").getByRole("button", { name: `React ${label}`, exact: true }).click();
    await delivered(a, emoji, before);
    check(await store(a, () => window.__emberisle.getState().chatOpen), `chat panel: one tap on ${label} sends it and keeps the panel open`);
    if (index === 0) check(await a.page.getByRole("button", { name: "React happy", exact: true }).isDisabled(), "chat panel: the emoji dim and disable during the cooldown");
  }
  // In the game dock keys 1-6 send them too while the focus is outside the input.
  await a.page.waitForFunction(() => !document.querySelector('[data-testid="emoji-row"] button')?.disabled);
  await a.page.getByTestId("chat-log").focus();
  let before = await receivedCount();
  await a.page.keyboard.press("5");
  await delivered(a, "🔥", before);
  check(true, "chat panel: key 5 sends fire while the panel is open");
  // Each emote also writes a light line in the sender's log, folded "×n" when repeated.
  await a.page.getByTestId("chat-log").locator('[data-testid="react-line"][data-emote="🔥"]').last().waitFor();
  check(true, "chat panel: an emote writes a light line in the log");
  // Use the real chat input: typing a digit there is text, not a reaction.
  await a.page.waitForFunction(() => !document.querySelector('[data-testid="emoji-row"] button')?.disabled);
  const input = a.page.getByPlaceholder("Say something…");
  before = await receivedCount();
  await input.focus();
  await input.press("1");
  await new Promise((r) => setTimeout(r, 400));
  check(await input.inputValue() === "1" && (await receivedCount()) === before, "chat panel: typing 1 in chat types it and sends no reaction");
  await input.fill("");
  await input.press("Escape");
  await a.page.getByRole("button", { name: /^Open chat/ }).waitFor();
  check(true, "chat panel: Escape from the chat input minimizes chat");

  // Tab 2: the sticker sends from Sounds & stickers, and the receiving seat shows it.
  await openChat(a);
  await showTab(a, "Sounds & stickers");
  before = await receivedCount();
  await a.page.getByTestId("stickers").getByRole("button", { name: "React ben-10", exact: true }).click();
  await delivered(a, "ben-10", before);
  await b.page.locator('[data-testid="reaction"][data-emote="ben-10"] img').waitFor();
  check(true, "chat panel: the sticker sends from the Sounds & stickers tab");
  // #1129: each of the five newest stickers reaches the other seat as an image through the host.
  for (const id of NEW_STICKERS) {
    before = await receivedCount();
    await a.page.getByTestId("stickers").getByRole("button", { name: `React ${id}`, exact: true }).click();
    await delivered(a, id, before);
    await b.page.locator(`[data-testid="reaction"][data-emote="${id}"] img`).waitFor();
    check(true, `chat panel: sticker ${id} is sent and seen by another seat`);
    await new Promise((r) => setTimeout(r, 600));
  }
  await showTab(a, "Chat");
  await closeChat(a);

  await openChat(phone);
  before = await receivedCount();
  await phone.page.getByTestId("emoji-row").getByRole("button", { name: "React sheep", exact: true }).tap();
  await delivered(phone, "🐑", before);
  check(await store(phone, () => window.__emberisle.getState().chatOpen), "chat panel: a phone tap sends from the open sheet and keeps it open");
  await closeChat(phone);

  // This bypasses the picker allowlist. The valid chat marker on the same ordered socket proves the host processed all three bad frames.
  const invalid = ["not-an-emote", "🙃", "https://example.invalid/reaction.png"];
  const marker = `reaction-validation-${Date.now()}`;
  await c.page.evaluate(({ invalid, marker }) => {
    const s = window.__emberisle.getState();
    for (const id of invalid) s.net.react(id);
    s.sendChat(marker);
  }, { invalid, marker });
  await b.page.waitForFunction((marker) => window.__emberisle.getState().chat.some((line) => line.text === marker), marker);
  check(await b.page.evaluate((invalid) => !window.__reactionProofReceived.some((r) => invalid.includes(r.emote)), invalid), "quick reactions: host drops an unknown id, unlisted emoji, and URL");

  const target = (await identity(a)).seat;
  const sender = await identity(phone);
  await phone.page.evaluate((target) => {
    const s = window.__emberisle.getState();
    s.sendReact("🔥", target);
    s.sendReact("🔥", target);
  }, target);
  for (const [t, anchor] of [[b, `rail-${sender.player}`], [phone, `seat-${sender.player}`]]) {
    const float = t.page.getByTestId(anchor).getByTestId("reaction");
    await float.getByTestId("reaction-count").getByText("×2", { exact: true }).waitFor();
    check(await float.count() === 1, `quick reactions: repeats coalesce at ${t.name}'s sender seat`);
    const fits = await float.evaluate((wrapper) => {
      const element = wrapper.firstElementChild;
      const animation = element.getAnimations()[0];
      if (!animation) return false;
      animation.pause();
      for (const time of [0, 1500, 1999]) {
        animation.currentTime = time;
        for (const node of [element, ...element.querySelectorAll("img,span")]) {
          const r = node.getBoundingClientRect();
          if (r.left < 7.9 || r.top < 7.9 || r.right > innerWidth - 7.9 || r.bottom > innerHeight - 7.9) return false;
        }
      }
      return true;
    });
    check(fits, `quick reactions: ${t.name} float, badge and target fit at every sampled animation frame`);
    // #899: the bubble hangs off the card (right of the rail card, under the strip cell) and never crosses the seat's name.
    const name = await clearOfName(t, anchor);
    check(name.ok, `seat bubble: at ${t.name}'s ${anchor.split("-")[0]} the bubble box and the name box don't intersect ${name.why}`);
    const place = await t.page.getByTestId(anchor).evaluate((card) => {
      const c = card.getBoundingClientRect();
      const b = card.querySelector("[data-seat-bubble] > div").getBoundingClientRect();
      return { right: b.left >= c.right, under: b.top >= c.bottom };
    });
    check(anchor.startsWith("rail") ? place.right : place.under, `seat bubble: at ${t.name} it sits ${anchor.startsWith("rail") ? "right of the rail card" : "under the strip cell"}`);
  }
  await phone.page.emulateMedia({ reducedMotion: "reduce" });
  await phone.page.evaluate(() => window.__emberisle.getState().sendReact("👏"));
  const reduced = phone.page.getByTestId(`seat-${sender.player}`).locator('[data-testid="reaction"][data-emote="👏"] > div');
  await reduced.waitFor();
  const fadeOnly = await reduced.evaluate((element) => {
    return element.getAnimations().length === 0 && getComputedStyle(element).opacity === "1" && getComputedStyle(element).transform === "none";
  });
  check(fadeOnly, "quick reactions: reduced motion stays fully static");
  await phone.page.emulateMedia({ reducedMotion: "no-preference" });
  for (const t of [a, b, c, phone]) {
    await openChat(t);
    await closeChat(t);
    await t.page.waitForFunction(() => document.querySelectorAll('[data-testid="reaction"]').length === 0, null, { timeout: 6000 });
  }
  await b.page.evaluate(() => window.__reactionProofUnsubscribe());
}

try {
  const tabs = [await tab("Ember"), await tab("Tide"), await tab("Pine")];
  const [a, b, c] = tabs;
  const phone = await tab("Moss", true);

  // #418: the host's status line says what is still missing, from the seat list alone, as seats join and ready up.
  const statusIs = (t, text) =>
    until(async () => (await t.page.getByTestId("lobby-status").textContent()).trim() === text, `${t.name} lobby status "${text}"`).then(() =>
      check(true, `lobby status on ${t.name}: "${text}"`),
    );
  await a.page.getByRole("button", { name: "Host a table" }).click();
  const tableCode = (await a.page.getByTestId("table-code").textContent()).trim();
  await statusIs(a, "Need 2 more players");
  for (const [i, t] of [b, c].entries()) {
    await t.page.getByPlaceholder(/code/i).fill(tableCode);
    await t.page.getByRole("button", { name: "Join" }).click();
    await t.page.getByTestId("table-code").waitFor();
    await statusIs(a, i === 0 ? "Need 1 more player" : "0 of 3 ready");
    // A guest tab reads the same status off the same seat list.
    await statusIs(b, i === 0 ? "Need 1 more player" : "0 of 3 ready");
  }
  // The host tag sits on the host's row only, on every tab.
  for (const t of tabs) {
    await until(
      async () => (await t.page.getByTestId("host-tag").count()) === 1 && (await t.page.locator("li", { hasText: "Ember" }).getByTestId("host-tag").count()) === 1,
      `${t.name} sees one host tag, on Ember's row`,
    );
    check(true, `host tag on Ember's row only, seen by ${t.name}`);
  }
  for (const t of tabs) {
    await until(async () => (await t.page.locator("li", { hasText: "Pine" }).count()) === 1, `${t.name} sees 3 seats`);
  }

  // Phone title card (#178): full width minus 12 px, at most 55% of the viewport, pinned to the bottom.
  const box = (t, sel) => t.page.evaluate((q) => {
    const r = document.querySelector(q).getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight };
  }, sel);
  await phone.page.getByTestId("title-card").waitFor();
  let r = await box(phone, '[data-testid="title-card"]');
  check(r.height <= 0.55 * r.vh + 0.5, `phone title card is ${r.height.toFixed(0)} px tall, at most 55% of ${r.vh}`);
  check(Math.abs(r.width - (r.vw - 24)) < 1 && r.left >= 11 && r.bottom > r.vh - 20, "phone title card is full width minus 12 px, at the bottom");
  await shot(phone, "chat-phone-title.jpg");
  await phone.page.getByPlaceholder(/code/i).fill(tableCode);
  await phone.page.getByRole("button", { name: "Join" }).click();
  await phone.page.getByTestId("table-code").waitFor();
  r = await box(phone, '[data-testid="lobby-card"]');
  // The lobby sheet used to stop at 55vh, which left the chat one line. It may now use the whole screen below the notch (see "chat is readable" below).
  check(Math.abs(r.top - 16) < 1 && Math.abs(r.left - 16) < 1 && Math.abs(r.height - (r.vh - 32)) < 1 && Math.abs(r.width - (r.vw - 32)) < 1, `phone lobby card is ${r.width.toFixed(0)}x${r.height.toFixed(0)}, inside the ${r.vw}x${r.vh} screen with the approved 16 px margins`);
  await shot(phone, "chat-phone-lobby.jpg");
  // Four seats, scrolled to the bottom, at 844 and 640 tall: the sticky actions row reaches the card's bottom edge, so no
  // scroll content (chat chips, input, seat rows) renders below it, and Leave lives inside it.
  for (const h of [844, 640]) {
    await phone.page.setViewportSize({ width: 390, height: h });
    await phone.page.evaluate(() => { const s = document.querySelector('[data-testid="lobby-card"] > div'); s.scrollTop = s.scrollHeight; });
    await shot(phone, `chat-phone-lobby-bottom-${h}.jpg`);
    const m = await phone.page.evaluate(() => {
      const scroller = document.querySelector('[data-testid="lobby-card"] > div');
      const row = document.querySelector('[data-testid="lobby-actions"]');
      const rb = row.getBoundingClientRect().bottom;
      const below = [...scroller.querySelectorAll("*")].filter((el) => !row.contains(el) && el !== row && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().bottom > rb + 0.5 && !el.contains(row)).map((el) => el.tagName);
      const leave = [...row.querySelectorAll("button")].some((b) => b.textContent.trim() === "Leave the table");
      return { gap: Math.round((scroller.getBoundingClientRect().bottom - 1 - rb) * 10) / 10, below, leave };
    });
    check(Math.abs(m.gap - 12) <= 0.1 && m.below.length === 0 && m.leave, `phone lobby 390x${h}, 4 seats scrolled down: footer keeps the approved 12 px bottom padding (gap ${m.gap}), nothing below it, Leave inside it`);
  }
  await phone.page.setViewportSize({ width: 390, height: 844 });
  await phone.page.evaluate(() => { document.querySelector('[data-testid="lobby-card"] > div').scrollTop = 0; });
  // #389: Ready and Start are in the first screenful of the phone lobby, with no scrolling.
  const inView = (t, sel) => t.page.evaluate((q) => {
    const r = document.querySelector(q).getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  }, sel);
  check((await phone.page.evaluate(() => document.querySelector('[data-testid="lobby-card"] > div').scrollTop)) === 0, "phone lobby: the card starts unscrolled");
  const readyBtn = phone.page.getByRole("button", { name: "Ready", exact: true });
  check(await readyBtn.evaluate((el) => { const r = el.getBoundingClientRect(); const c = document.querySelector('[data-testid="lobby-card"]').getBoundingClientRect(); return r.top >= c.top && r.bottom <= c.bottom && r.bottom <= innerHeight; }), "phone lobby: Ready is inside the card and the 390x844 viewport without scrolling");
  // The host's phone: once three seats are ready, Start joins Ready and is in view too.
  const hp = await tab("Hana", true);
  await hp.page.getByRole("button", { name: "Host a table" }).click();
  const hCode = (await hp.page.getByTestId("table-code").textContent()).trim();
  const guests = [await tab("Gus"), await tab("Ivy")];
  for (const g of guests) {
    await g.page.getByPlaceholder(/code/i).fill(hCode);
    await g.page.getByRole("button", { name: "Join" }).click();
    await g.page.getByTestId("table-code").waitFor();
  }
  for (const t of [hp, ...guests]) await t.page.getByRole("button", { name: "Ready", exact: true }).click();
  const startBtn = hp.page.getByRole("button", { name: "Start", exact: true });
  await startBtn.waitFor({ timeout: 10_000 });
  check(await startBtn.evaluate((el) => { const r = el.getBoundingClientRect(); const c = document.querySelector('[data-testid="lobby-card"]').getBoundingClientRect(); return r.top >= c.top && r.bottom <= c.bottom && r.bottom <= innerHeight; }), "phone lobby: Start is inside the card and the 390x844 viewport without scrolling");
  check(await inView(hp, '[data-testid="lobby-actions"]'), "phone lobby: the Ready/Start row is wholly on screen");
  await shot(hp, "chat-phone-lobby-host.jpg");
  // Chat is readable in the phone lobby: at 390x844 and 440x956 at least four whole lines show, the newest is one of them, and the
  // quick reactions (the emote tray) do not push the log out of the card.
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8]) await SAY(guests[0], `lobby line ${i}`);
  await until(async () => (await logView(hp)).total >= 8, `Hana's lobby chat has all eight lines (${JSON.stringify(await logView(hp))})`);
  for (const [w, h] of [[390, 844], [440, 956]]) {
    await hp.page.setViewportSize({ width: w, height: h });
    await until(async () => (await logView(hp)).whole >= 4, `${w}x${h} lobby: four whole chat lines are on screen`, 3000).catch(() => {});
    const v = await logView(hp);
    check(v.whole >= 4 && v.newest && v.newestText.includes("lobby line 8") && v.font >= 14, `phone lobby ${v.size}: ${v.whole} whole chat lines on screen, newest ("${v.newestText.trim()}") visible, ${v.font}px text`);
    check(await inView(hp, '[data-testid="lobby-actions"]'), `phone lobby ${v.size}: Ready/Start stay on screen beside the chat`);
    if (w === 440) await shot(hp, "chat-lobby-440x956.jpg");
    // #899: the lobby box has the same two tabs. Sounds & stickers shows all ten chips with no sideways scroll, inside the box.
    await hp.page.getByRole("tab", { name: "Sounds & stickers", exact: true }).click();
    const board = await hp.page.getByTestId("soundboard").evaluate((el, legacyLabels) => {
      const box = document.querySelector('[data-testid="lobby-chat"]').getBoundingClientRect();
      const buttons = [...el.querySelectorAll("button")];
      const chips = buttons.map((b) => b.getBoundingClientRect());
      return { n: buttons.filter((b) => legacyLabels.includes(b.getAttribute("aria-label"))).length, total: buttons.length, wide: el.scrollWidth > el.clientWidth + 0.5, inside: chips.every((r) => r.left >= box.left && r.right <= box.right), font: parseFloat(getComputedStyle(el.querySelector("button")).fontSize) };
    }, ["Play sound Fah", "Play sound Wololo", "Play sound GG!", "Play sound Airhorn", "Play sound Quit touchin' me", "Play sound Wood please", "Play sound Perfect", "Play sound Bong"]);
    check(board.n === 8 && !board.wide && board.inside && board.font >= 14, `phone lobby ${v.size}: the Sounds & stickers tab shows all 8 listed chips at ${board.font}px with no sideways scroll`);
    check(board.total === 15 && !board.wide && board.inside, `phone lobby ${v.size}: the Sounds & stickers tab shows all 15 chips inside the box`);
    if (w === 390) await newContent(hp, "390x844");
    await hp.page.getByRole("tab", { name: "Chat", exact: true }).click();
    const back = await logView(hp);
    check(back.whole >= 4 && back.newest, `phone lobby ${v.size}: back on the Chat tab, ${back.whole} chat lines and the newest are on screen`);
  }
  await SAY(guests[0], "lobby line 9");
  await until(async () => (await logView(hp)).newestText.includes("lobby line 9") && (await logView(hp)).newest, "a new lobby line scrolls into view");
  check(true, "phone lobby: a line that arrives while the log is at the bottom is scrolled into view");
  // #449: held sideways, the lobby is a two-column card, so with four seats and everyone ready the status line, Ready, Start
  // and Leave are all on screen with no scrolling (the card's own scroller stays at 0).
  const fourth = await tab("Fay");
  await fourth.page.getByPlaceholder(/code/i).fill(hCode);
  await fourth.page.getByRole("button", { name: "Join" }).click();
  await fourth.page.getByTestId("table-code").waitFor();
  await fourth.page.getByRole("button", { name: "Ready", exact: true }).click();
  await until(async () => (await hp.page.locator("li", { hasText: "Fay" }).count()) === 1, "Hana sees four seats");
  await until(async () => (await hp.page.getByTestId("lobby-status").textContent()).trim() === "Everyone is ready", "Hana sees Everyone is ready");
  for (const [w, h] of [[844, 390], [667, 375]]) {
    await hp.page.setViewportSize({ width: w, height: h });
    await shot(hp, `chat-phone-lobby-landscape-${w}x${h}.jpg`);
    await until(
      () => hp.page.evaluate(() => document.querySelector('[data-testid="lobby-card"]').getBoundingClientRect().width > innerWidth * 0.8),
      `${w}x${h}: the lobby card is the wide landscape card`,
    );
    const m = await hp.page.evaluate(() => {
      const card = document.querySelector('[data-testid="lobby-card"]');
      const inside = (el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; };
      const btn = (t) => [...card.querySelectorAll("button")].find((b) => b.textContent.trim() === t);
      const scrollers = [card, ...card.querySelectorAll("*")].filter((el) => getComputedStyle(el).overflowY === "auto" && el.getAttribute("data-testid") !== "chat-log");
      return {
        status: inside(document.querySelector('[data-testid="lobby-status"]')),
        ready: !!btn("Not ready") && inside(btn("Not ready")),
        start: !!btn("Start") && inside(btn("Start")),
        leave: !!btn("Leave the table") && inside(btn("Leave the table")),
        seats: [...card.querySelectorAll("li")].filter((li) => !li.closest('[data-testid="chat-log"]') && li.querySelector("span.rounded-full") && inside(li)).length,
        scroll: scrollers.map((el) => el.scrollHeight - el.clientHeight),
        top: card.getBoundingClientRect().top,
      };
    });
    check(m.status && m.ready && m.start && m.leave, `phone landscape ${w}x${h}, 4 seats all ready: status, Ready, Start and Leave are on screen without scrolling`);
    check(m.seats === 4, `phone landscape ${w}x${h}: all four seat rows are on screen`);
    check(m.scroll.every((n) => n <= 1), `phone landscape ${w}x${h}: nothing in the card scrolls (${m.scroll})`);
    // #899 (UI audit): your own name stays a 44 px touch target sideways.
    const rename = await hp.page.getByTestId("rename-seat").boundingBox();
    check(rename.width >= 44 - 0.5 && rename.height >= 44 - 0.5, `phone landscape ${w}x${h}: the rename button is ${rename.width.toFixed(1)}x${rename.height.toFixed(1)}, at least 44x44`);
    // #899 (UI audit): the Sounds & stickers tab gets real height sideways: every sound chip and the preset row show without
    // scrolling, or the scroll box is at least 1.5 chip rows (66 px) tall. Chips stay 44 px on touch.
    await hp.page.getByRole("tab", { name: "Sounds & stickers", exact: true }).click();
    const land = await hp.page.getByTestId("sounds-tab").evaluate((box, legacyLabels) => {
      const b = box.getBoundingClientRect();
      const buttons = [...box.querySelectorAll('[data-testid="soundboard"] button, [data-testid="presets"] button')];
      const chips = buttons.map((el) => el.getBoundingClientRect());
      const whole = chips.every((r) => r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5 && r.left >= b.left - 0.5 && r.right <= b.right + 0.5);
      return { n: buttons.filter((button) => legacyLabels.includes(button.getAttribute("aria-label")) || button.closest('[data-testid="presets"]')).length, total: buttons.length, whole, height: Math.round(box.clientHeight), scroll: box.scrollHeight, small: chips.filter((r) => r.height < 43.5).length, wide: box.scrollWidth > box.clientWidth + 0.5 };
    }, ["Play sound Fah", "Play sound Wololo", "Play sound GG!", "Play sound Airhorn", "Play sound Quit touchin' me", "Play sound Wood please", "Play sound Perfect", "Play sound Bong"]);
    check(land.n === 13 && land.small === 0 && !land.wide && (land.whole || land.height >= 66), `phone landscape ${w}x${h}: Sounds & stickers shows 8 listed chips and 5 presets at 44 px, ${land.whole ? "all without scrolling" : `in a ${land.height} px scroll box (scrollHeight ${land.scroll})`}`);
    check(land.total === 20 && land.small === 0 && !land.wide && (land.whole || land.height >= 66), `phone landscape ${w}x${h}: Sounds & stickers shows the 15 chips and 5 presets at 44 px`);
    if (w === 844) await newContent(hp, "844x390");
    await hp.page.getByRole("tab", { name: "Chat", exact: true }).click();
  }
  await fourth.page.context().close();
  for (const t of [hp, ...guests]) await t.page.context().close();
  for (const t of [...tabs, phone]) {
    await until(async () => (await t.page.locator("li", { hasText: "Moss" }).count()) >= 1, `${t.name} sees 4 seats`);
  }
  await statusIs(a, "0 of 4 ready");

  // 1. Lobby: a typed line with Enter, then a one-tap emoji and a sound (#899), on every tab.
  await a.page.getByPlaceholder("Say something…").fill("hello");
  await a.page.getByPlaceholder("Say something…").press("Enter");
  for (const t of tabs) {
    await t.page.getByTestId("chat-log").getByText("hello").waitFor({ timeout: 5000 });
    const line = await t.page.getByTestId("chat-log").locator("li", { hasText: "hello" }).textContent();
    check(line.includes("Ember"), `lobby: ${t.name} shows "hello" from Ember`);
  }
  // #899: the lobby has the six emoji too. One tap from Tide shows a bubble mid-row on Tide's seat, clear of the name, and a
  // light line in every log; a sound from Pine's Sounds & stickers tab shows its own bubble and line.
  const tideSeat = await store(b, () => window.__emberisle.getState().seatId);
  const pineSeat = await store(c, () => window.__emberisle.getState().seatId);
  await b.page.getByTestId("emoji-row").getByRole("button", { name: "React happy", exact: true }).click();
  for (const t of tabs) {
    await t.page.getByTestId(`lobby-seat-${tideSeat}`).locator('[data-testid="reaction"][data-emote="😊"]').waitFor({ timeout: 5000 });
    const name = await clearOfName(t, `lobby-seat-${tideSeat}`);
    check(name.ok, `lobby: ${t.name} shows Tide's 😊 bubble mid-row, and the bubble box and the name box don't intersect ${name.why}`);
    await t.page.getByTestId("chat-log").locator('[data-testid="react-line"][data-emote="😊"]', { hasText: "Tide" }).waitFor({ timeout: 5000 });
  }
  check(true, "lobby: Tide's one-tap emoji is a light line in all 3 logs");
  await c.page.getByRole("tab", { name: "Sounds & stickers", exact: true }).click();
  await c.page.getByRole("button", { name: "Play sound Wololo", exact: true }).click();
  for (const t of tabs) {
    await t.page.getByTestId(`lobby-seat-${pineSeat}`).locator('[data-testid="sound-bubble"][data-sound="sb_wololo"]').waitFor({ timeout: 5000 });
    const name = await clearOfName(t, `lobby-seat-${pineSeat}`);
    check(name.ok, `lobby: ${t.name} shows Pine's Wololo bubble, clear of the name ${name.why}`);
  }
  await c.page.getByRole("tab", { name: "Chat", exact: true }).click();
  for (const t of tabs) await t.page.getByTestId("chat-log").getByTestId("sound-line").filter({ hasText: "Wololo" }).waitFor({ timeout: 5000 });
  check(true, "lobby: Pine's sound is a bubble and a light line on all 3 tabs");
  // #1129: the two newest chips, one from each of two other seats, are a bubble and a sound line on every seat.
  for (const [sender, senderSeat, id, label] of [[b, tideSeat, "sb_real_badman", "Real badman"], [a, await store(a, () => window.__emberisle.getState().seatId), "sb_gong", "Gong"]]) {
    await sender.page.getByRole("tab", { name: "Sounds & stickers", exact: true }).click();
    await sender.page.getByRole("button", { name: `Play sound ${label}`, exact: true }).click();
    for (const t of tabs) await t.page.getByTestId(`lobby-seat-${senderSeat}`).locator(`[data-testid="sound-bubble"][data-sound="${id}"]`).waitFor({ timeout: 5000 });
    await sender.page.getByRole("tab", { name: "Chat", exact: true }).click();
    for (const t of tabs) await t.page.getByTestId("chat-log").getByTestId("sound-line").filter({ hasText: label }).waitFor({ timeout: 5000 });
    check(true, `lobby: ${label} from ${sender.name} is a bubble and a sound line on all 3 tabs`);
  }
  check((await a.page.getByPlaceholder("Say something…").inputValue()) === "", "lobby: input cleared after Enter");
  // #895: at 1280x720 the lobby input, Send and both tabs are reachable: a hit test at each centre finds the control itself,
  // not the Ready footer over it. Run as a guest and as the host once Start has joined the footer.
  const lobbyReach = async (t, when) => {
    const m = await t.page.evaluate(() => {
      const scroller = document.querySelector('[data-testid="lobby-card"] > div');
      const box = document.querySelector('[data-testid="lobby-chat"]');
      const find = (q) => box.querySelector(q);
      const send = [...box.querySelectorAll("button")].find((b) => b.textContent.trim() === "Send");
      const controls = { input: find("#chat-input"), Send: send, "Chat tab": find("#chat-tab-chat"), "Sounds & stickers tab": find("#chat-tab-sounds") };
      const out = {};
      for (const [k, el] of Object.entries(controls)) {
        if (!el) { out[k] = "missing"; continue; }
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        out[k] = hit === el || el.contains(hit) ? "ok" : `covered by ${hit?.closest("[data-testid]")?.getAttribute("data-testid") ?? hit?.tagName}`;
      }
      return { out, scrollTop: scroller.scrollTop, vw: innerWidth, vh: innerHeight };
    });
    const bad = Object.entries(m.out).filter(([, v]) => v !== "ok");
    check(m.vw === 1280 && m.vh === 720 && m.scrollTop === 0 && bad.length === 0, `desktop lobby 1280x720 ${when}: a hit test reaches the input, Send and both tabs, none under the footer ${JSON.stringify(m.out)}`);
  };
  for (const t of [a, b]) await lobbyReach(t, `(${t === a ? "host" : "guest"}, before Ready)`);
  await shot(a, "chat-lobby-desktop.jpg");

  for (const [i, t] of [...tabs, phone].entries()) {
    await t.page.getByRole("button", { name: "Ready", exact: true }).click();
    await statusIs(a, i < 3 ? `${i + 1} of 4 ready` : "Everyone is ready");
  }
  // #417: on the 1280x720 desktop card every seat ready means code, four rows, the chat box and Ready/Start/Leave; Start and
  // Leave must still sit inside the card's visible box without scrolling.
  await a.page.getByRole("button", { name: "Start", exact: true }).waitFor();
  check((await a.page.evaluate(() => document.querySelector('[data-testid="lobby-card"] > div').scrollTop)) === 0, "desktop lobby: the card starts unscrolled");
  const insideCard = (name) =>
    a.page.getByRole("button", { name, exact: true }).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const c = document.querySelector('[data-testid="lobby-card"]').getBoundingClientRect();
      return { ok: r.top >= c.top && r.bottom <= c.bottom && r.bottom <= innerHeight, bottom: Math.round(r.bottom), card: Math.round(c.bottom) };
    });
  for (const name of ["Start", "Leave the table"]) {
    const r = await insideCard(name);
    check(r.ok, `desktop lobby at 1280x720: ${name} is inside the card (bottom ${r.bottom} <= card ${r.card}) without scrolling`);
  }
  await lobbyReach(a, "(host, everyone ready, Start showing)");
  await a.page.getByRole("tab", { name: "Sounds & stickers", exact: true }).click();
  const lobbyBoard = await a.page.getByTestId("soundboard").evaluate((el, legacyLabels) => {
    const box = document.querySelector('[data-testid="lobby-chat"]').getBoundingClientRect();
    const reach = (b) => { const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit === b || b.contains(hit); };
    const chips = [...el.querySelectorAll("button")];
    const legacy = chips.filter((button) => legacyLabels.includes(button.getAttribute("aria-label")));
    return { n: legacy.length, total: chips.length, wide: el.scrollWidth > el.clientWidth + 0.5, inside: chips.every((b) => { const r = b.getBoundingClientRect(); return r.left >= box.left && r.right <= box.right; }), reached: legacy.filter(reach).length, totalReached: chips.filter(reach).length, tabs: ["#chat-tab-chat", "#chat-tab-sounds"].every((q) => reach(document.querySelector(q))) };
  }, ["Play sound Fah", "Play sound Wololo", "Play sound GG!", "Play sound Airhorn", "Play sound Quit touchin' me", "Play sound Wood please", "Play sound Perfect", "Play sound Bong"]);
  check(lobbyBoard.n === 8 && !lobbyBoard.wide && lobbyBoard.inside && lobbyBoard.tabs, `desktop lobby 1280x720 (host, Sounds & stickers tab): all 8 listed chips with no sideways scroll, both tabs reachable; ${lobbyBoard.reached} of 8 chips in view without scrolling the tab`);
  check(lobbyBoard.total === 15 && !lobbyBoard.wide && lobbyBoard.inside && lobbyBoard.tabs, `desktop lobby 1280x720 (host, Sounds & stickers tab): all 15 chips with no sideways scroll, both tabs reachable; ${lobbyBoard.totalReached} of 15 chips in view without scrolling the tab`);
  await newContent(a, "1280x720");
  await shot(a, "chat-lobby-desktop-sounds.jpg");
  await a.page.getByRole("tab", { name: "Chat", exact: true }).click();
  await a.page.getByRole("button", { name: "Start" }).click();
  for (const t of tabs) await t.page.getByRole("button", { name: "Open chat" }).waitFor();
  check(true, "game: every tab shows the minimized dock, and the lobby lines did not count as unread");
  for (const t of tabs) check((await t.page.getByTestId("chat-unread").count()) === 0, `game: ${t.name} has no unread badge`);
  await phone.page.getByRole("button", { name: "Open chat" }).waitFor();
  check((await phone.page.getByTestId("chat-sheet").count()) === 0, "phone: Play starts with the sheet closed although chat was remembered open");
  check((await phone.page.evaluate(() => localStorage.getItem("emberisle-chat-open"))) === "1", "phone: the remembered open state is left in storage");
  await quickReactions(a, b, c, phone);

  // #500: mute is local to this browser. The muted sender's line and reaction stay in store but vanish from this view,
  // then return immediately when the seat is unmuted.
  const mutedSeat = await store(c, () => window.__emberisle.getState().seatId);
  const mutedPlayer = await store(c, () => window.__emberisle.getState().localId);
  await a.page.getByRole("button", { name: "Open chat" }).click();
  await a.page.getByRole("button", { name: "Mute players", exact: true }).click();
  const mute = a.page.getByTestId(`chat-mute-seat-${mutedSeat}`);
  await mute.click();
  check(await mute.getAttribute("aria-pressed") === "true", "mute: Pine is muted in this chat dock");
  await polish(a, "mute panel", "#chat-mute-panel", 3);
  const mutedLine = `muted-line-${Date.now()}`;
  await c.page.evaluate((text) => window.__emberisle.getState().sendChat(text), mutedLine);
  await a.page.waitForFunction((text) => window.__emberisle.getState().chat.some((line) => line.text === text), mutedLine);
  check((await a.page.getByTestId("chat-log").locator("li").filter({ hasText: mutedLine }).count()) === 0, "mute: Pine's chat line is hidden only in Ember's view");
  await a.page.getByRole("button", { name: "Mute player Pine", exact: true }).click();
  await a.page.getByTestId("chat-log").locator("li").filter({ hasText: mutedLine }).waitFor();
  check(true, "mute: unmuting Pine restores the earlier chat line");

  // #520: the seat button keeps one name and says its state with aria-pressed (no flipping label as well); the panel closes on
  // Escape (focus back on the toggle) and on a press outside; Escape closes only the topmost layer.
  const muteToggle = a.page.getByRole("button", { name: "Mute players", exact: true });
  const mutePanel = a.page.getByTestId("chat-mute-panel");
  check((await mute.getAttribute("aria-label")) === "Mute player Pine" && (await mute.getAttribute("aria-pressed")) === "false", "mute panel: Pine's button is named \"Mute player Pine\" with aria-pressed false while unmuted");
  await mute.click();
  check((await mute.getAttribute("aria-label")) === "Mute player Pine" && (await mute.getAttribute("aria-pressed")) === "true", "mute panel: the name is unchanged and aria-pressed is true once muted");
  await mute.click();
  await mute.focus();
  await a.page.keyboard.press("Escape");
  check((await mutePanel.count()) === 0, "mute panel: Escape closes it");
  check(await muteToggle.evaluate((el) => el === document.activeElement), "mute panel: Escape returns focus to the Mute toggle");
  check((await a.page.getByRole("button", { name: "Minimize chat" }).count()) === 1, "mute panel: Escape closed only the panel; the chat stays open");
  await muteToggle.click();
  await mutePanel.waitFor();
  await a.page.getByTestId("chat-log").click({ position: { x: 4, y: 4 } });
  check((await mutePanel.count()) === 0, "mute panel: a press outside closes it");
  // Escape order over an armed build: the first Escape closes the panel, the second disarms the build.
  await a.page.evaluate(() => window.__emberisle.getState().setBuildMode("path"));
  await muteToggle.click();
  await mutePanel.waitFor();
  await mute.focus();
  await a.page.keyboard.press("Escape");
  check((await mutePanel.count()) === 0 && (await a.page.evaluate(() => window.__emberisle.getState().buildMode)) === "path", "mute panel over an armed build: the first Escape closes the panel and leaves the build armed");
  await a.page.keyboard.press("Escape");
  check((await a.page.evaluate(() => window.__emberisle.getState().buildMode)) === "none", "mute panel over an armed build: the second Escape disarms the build");
  await muteToggle.click();
  await mutePanel.waitFor();

  await a.page.getByRole("button", { name: "Mute player Pine", exact: true }).click();
  await openChat(c);
  await c.page.getByTestId("emoji-row").getByRole("button", { name: "React fire", exact: true }).click();
  await closeChat(c);
  await a.page.waitForFunction(({ seat, emote }) => window.__emberisle.getState().reactions.some((r) => r.seat === seat && r.emote === emote), { seat: mutedSeat, emote: "🔥" });
  const mutedFloat = a.page.locator(`[data-testid="rail-${mutedPlayer}"] [data-testid="reaction"][data-emote="🔥"]`);
  const mutedReactLine = a.page.getByTestId("chat-log").locator('[data-testid="react-line"][data-emote="🔥"]').filter({ hasText: "Pine" });
  check((await mutedFloat.count()) === 0 && (await mutedReactLine.count()) === 0, "mute: Pine's reaction bubble and its log line are hidden only in Ember's view");
  await a.page.getByRole("button", { name: "Mute player Pine", exact: true }).click();
  await mutedFloat.waitFor({ timeout: 1500 });
  await mutedReactLine.first().waitFor({ timeout: 1500 });
  check(true, "mute: unmuting Pine restores the active reaction and its log line");

  await a.page.getByRole("button", { name: "Mute player Pine", exact: true }).click();
  await a.page.getByRole("button", { name: "Minimize chat" }).click();
  const mutedUnread = `muted-unread-${Date.now()}`;
  await c.page.evaluate((text) => window.__emberisle.getState().sendChat(text), mutedUnread);
  await a.page.waitForFunction((text) => window.__emberisle.getState().chat.some((line) => line.text === text), mutedUnread);
  check((await a.page.getByTestId("chat-unread").count()) === 0, "mute: a muted player's line does not add to unread");
  const visibleUnread = `visible-unread-${Date.now()}`;
  await b.page.evaluate((text) => window.__emberisle.getState().sendChat(text), visibleUnread);
  await a.page.getByTestId("chat-unread").filter({ hasText: "1" }).waitFor({ timeout: 5000 });
  check((await a.page.getByTestId("chat-unread").textContent()) === "1", "mute: unread counts only the unmuted player's line");
  await a.page.getByRole("button", { name: "Open chat, 1 unread", exact: true }).click();
  await a.page.getByTestId("chat-unread").waitFor({ state: "detached" });
  await a.page.getByRole("button", { name: "Mute players", exact: true }).click();
  await a.page.getByRole("button", { name: "Mute player Pine", exact: true }).click();

  // Storage can be unavailable in a private or quota-limited context. The preference still applies in this tab.
  await a.page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("emberisle-chat-muted-")) throw new DOMException("blocked", "QuotaExceededError");
      return original.call(this, key, value);
    };
    window.__restoreStorageSetItem = () => { Storage.prototype.setItem = original; };
  });
  await a.page.getByRole("button", { name: "Mute player Pine", exact: true }).click();
  check(await a.page.getByTestId(`chat-mute-seat-${mutedSeat}`).getAttribute("aria-pressed") === "true", "mute: blocked storage still mutes in the current tab");
  check((await a.page.getByTestId("chat-log").locator("li").filter({ hasText: mutedLine }).count()) === 0, "mute: blocked storage still hides Pine's chat line");
  await a.page.evaluate(() => window.__restoreStorageSetItem());
  await a.page.getByRole("button", { name: "Mute player Pine", exact: true }).click();
  await a.page.getByTestId("chat-log").locator("li").filter({ hasText: mutedLine }).waitFor();
  check(true, "mute: blocked-storage preference can be cleared in the current tab");
  await a.page.getByRole("button", { name: "Minimize chat" }).click();

  // #232: roll off for first place; whichever seat is up rolls, until setup starts.
  await until(async () => {
    for (const t of [...tabs, phone]) {
      const phase = await t.page.evaluate(() => {
        const s = window.__emberisle.getState();
        if (s.state?.phase === "rollOff" && s.state.current === s.localId && s.legal?.actions.includes("roll")) s.dispatch({ type: "roll" });
        return s.state?.phase;
      });
      if (phase === "setupSettle") return true;
    }
    return null;
  }, "the roll-off ends");

  // 5. Minimized dock covers no target. A line from another seat is showing under the button, and it must not catch clicks either.
  // If the phone won the roll-off, it places its first outpost and path so a desktop tab is up.
  const cur = await until(async () => {
    await phone.page.evaluate(() => {
      const s = window.__emberisle.getState();
      if (s.state?.current !== s.localId) return;
      if (s.legal?.outpost?.length) s.pickVertex(s.legal.outpost[0]);
      else if (s.state.phase === "setupRoad" && s.legal?.path?.length) s.pickEdge(s.legal.path[0]);
    });
    for (const t of tabs) {
      const own = await t.page.evaluate(() => {
        const s = window.__emberisle.getState();
        return s.state?.current === s.localId && s.legal?.outpost?.length ? s.localId : null;
      });
      if (own) return t;
    }
    return null;
  }, "someone has legal corners");
  const other = tabs.find((t) => t !== cur);
  // #899 (owner change): the third tab keeps its chat open, so it must see the line only in its log, never as a bubble.
  const third = tabs.find((t) => t !== cur && t !== other);
  await openChat(third);
  const otherId = await store(other, () => window.__emberisle.getState().localId);
  await other.page.getByRole("button", { name: "Open chat" }).click();
  await other.page.getByPlaceholder("Say something…").fill("preview line");
  await other.page.getByPlaceholder("Say something…").press("Enter");
  // #899 (owner decision): no preview pills; the line shows only as the seat bubble, and the chat button counts it.
  // With chat closed, the line shows as a bubble at the sender's rail card, clear of the name, and fades like a sticker.
  const closedBubble = cur.page.getByTestId(`rail-${otherId}`).getByTestId("chat-bubble");
  await closedBubble.filter({ hasText: "preview line" }).waitFor({ timeout: 5000 });
  const bubbleName = await clearOfName(cur, `rail-${otherId}`);
  check(bubbleName.ok, `closed chat: ${cur.name} sees ${other.name}'s line as a bubble at the seat; bubble box and name box don't intersect ${bubbleName.why}`);
  check(await closedBubble.evaluate((el) => el.firstElementChild.getAnimations().some((a) => Number(a.effect.getKeyframes().at(-1).opacity) === 0)), "closed chat: the bubble fades out (its animation ends at opacity 0)");
  await third.page.getByTestId("chat-log").locator("li", { hasText: "preview line" }).waitFor({ timeout: 5000 });
  check((await third.page.getByTestId("chat-bubble").count()) === 0, `open chat: ${third.name}, chat open, shows the line in the log and no bubble`);
  await closeChat(third);
  await polish(cur, "minimized", '[aria-label^="Open chat"]');
  check((await cur.page.getByTestId("chat-preview").count()) === 0 && (await cur.page.getByTestId("chat-unread-preview").count()) === 0 && (await cur.page.getByTestId("chat-unread").count()) === 1, "closed chat (owner decision): no preview pills under the top-right icons, only the unread badge on the chat button");
  const hits = await cur.page.evaluate(() => {
    const s = window.__emberisle.getState();
    const ids = [...s.legal.outpost, ...s.legal.path, ...s.legal.wayfarer, ...s.state.hexes.map((h) => h.id)];
    const out = { checked: 0, canvas: 0, chat: [] };
    for (const id of ids) {
      const p = window.__isle.screenOf(id);
      if (!p || p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight) continue;
      out.checked++;
      const el = document.elementFromPoint(p.x, p.y);
      if (el?.tagName === "CANVAS") out.canvas++;
      if (el?.closest('[aria-label^="Open chat"], [data-testid="chat-preview"], [aria-label="Table chat"]')) out.chat.push(id);
    }
    return out;
  });
  check(hits.checked > 20, `minimized dock: ${hits.checked} legal corners, edges, and hexes are on screen`);
  check(hits.chat.length === 0, `minimized dock: no target is covered by chat (${hits.canvas} reach the canvas, the rest sit under the HUD)`);
  await shot(cur, "chat-minimized.jpg");
  await closedBubble.waitFor({ state: "detached", timeout: 6000 });
  check(true, "closed chat: the line's bubble is gone after its lifetime");
  // Owner decision (#918): the text presets are a row in the Sounds & stickers tab. One tap on "gg" sends it as a chat line:
  // every tab's log shows it, and a closed chat shows it as a bubble at the sender's seat.
  await showTab(other, "Sounds & stickers");
  await other.page.getByTestId("presets").getByRole("button", { name: "gg", exact: true }).click();
  await cur.page.getByTestId(`rail-${otherId}`).getByTestId("chat-bubble").filter({ hasText: "gg" }).waitFor({ timeout: 5000 });
  check(true, `presets: ${other.name}'s "gg" shows as a closed-chat bubble on ${cur.name}`);
  await showTab(other, "Chat");
  for (const t of tabs) {
    const wasOpen = await store(t, () => window.__emberisle.getState().chatOpen);
    if (!wasOpen) await openChat(t);
    await t.page.getByTestId("chat-log").locator("li", { hasText: /gg$/ }).filter({ hasText: other.name }).last().waitFor({ timeout: 5000 });
    if (!wasOpen) await closeChat(t);
  }
  check(true, `presets: ${other.name}'s "gg" is a chat line in all 3 logs`);
  await cur.page.getByTestId("chat-bubble").waitFor({ state: "detached", timeout: 6000 });

  // 2. A sticker from the Sounds & stickers tab shows beside the sender's rail card on the other tabs, and is gone after its lifetime.
  await openChat(c);
  await showTab(c, "Sounds & stickers");
  await c.page.getByRole("button", { name: "React ben-10" }).click();
  for (const t of [a, b]) {
    const float = t.page.locator("aside [data-testid=reaction][data-emote=ben-10]");
    await float.waitFor({ timeout: 5000 });
    const owner = await float.locator("xpath=ancestor::div[contains(@class,'relative')][1]").textContent();
    check(owner.includes("Pine"), `reaction: ${t.name} shows ben-10 beside Pine's card`);
    const box = await float.locator("img").boundingBox();
    check(Math.round(box.width) === 48, `reaction: ${t.name} image is 48 px wide`);
  }
  await showTab(c, "Chat");
  await closeChat(c);
  for (const t of tabs) {
    await t.page.locator("[data-testid=reaction]").waitFor({ state: "detached", timeout: 6000 });
    check((await t.page.locator("[data-testid=reaction]").count()) === 0, `reaction: gone after its lifetime on ${t.name}`);
  }

  // 3. Tab 1 clicks tab 2's card (#161): an accordion menu in the rail with the card's 4 facts, a reaction aimed at Tide,
  // Mention fills the input, and Esc, the same card, and a click outside all close it.
  const bId = await store(b, () => window.__emberisle.getState().localId);
  const card = a.page.getByTestId(`rail-${bId}`).getByRole("button");
  const menu = a.page.getByTestId("player-menu");
  await card.click();
  await menu.waitFor();
  check((await card.getAttribute("aria-expanded")) === "true", "menu: Tide's card is a button with aria-expanded");
  // #443: the card is one line; a goods or fortunes count shows only when it is held, and the points read "N points".
  const cardText = await a.page.getByTestId(`rail-${bId}`).textContent();
  const fromCard = [
    Number(cardText.match(/(\d+) goods?/)?.[1] ?? 0),
    Number(cardText.match(/(\d+) fortunes?/)?.[1] ?? 0),
    Number(cardText.match(/(\d+) points/)[1]),
    await a.page.evaluate((id) => window.__emberisle.getState().state.players.find((p) => p.id === id).knightsPlayed, bId),
  ];
  const facts = (await menu.getByTestId("menu-facts").locator("dd").allTextContents()).map(Number);
  check(facts.length === 4 && facts.every((n, i) => n === fromCard[i]), `menu: 4 facts ${JSON.stringify(facts)} equal the card's numbers`);
  const geo = await a.page.evaluate((id) => {
    const r = (el) => el.getBoundingClientRect();
    const aside = r(document.querySelector("aside"));
    const card = r(document.querySelector(`[data-testid="rail-${id}"]`));
    const menu = r(document.querySelector('[data-testid="player-menu"]'));
    const cards = [...document.querySelectorAll('[data-testid^="rail-"]')].map(r);
    const below = cards.find((c) => c.top > card.top);
    return { inRail: menu.left >= aside.left - 1 && menu.right <= aside.right + 1, under: menu.top >= card.bottom, pushed: !below || below.top >= menu.bottom };
  }, bId);
  check(geo.inRail && geo.under && geo.pushed, "menu: sits in the rail column under the card and pushes the cards below it down");
  check((await menu.getByRole("button", { name: /Offer a trade/ }).count()) === 0, "menu: no Offer a trade row outside your main phase");
  await shot(a, "menu-open.jpg");
  // #899: the menu's lone sticker is gone; reactions come only from the chat panel.
  check((await menu.getByTestId("menu-emotes").count()) === 0 && (await menu.getByRole("button", { name: /^React / }).count()) === 0, "menu: no sticker or reaction buttons; reactions come only from the chat panel");
  await card.click();
  await menu.waitFor({ state: "detached" });
  await card.click();
  await menu.waitFor();
  await a.page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  check(await card.evaluate((el) => document.activeElement === el), "menu: Esc closes it and the focus returns to the card");
  await card.click();
  await menu.waitFor();
  await card.click();
  await menu.waitFor({ state: "detached" });
  check(true, "menu: the same card closes it");
  await card.click();
  await menu.waitFor();
  await a.page.getByTestId("turn-banner").click();
  await menu.waitFor({ state: "detached" });
  check(true, "menu: a click outside closes it");
  await card.click();
  await menu.getByRole("button", { name: "Mention @Tide in chat" }).click();
  await menu.waitFor({ state: "detached" });
  await a.page.getByPlaceholder("Say something…").waitFor();
  check((await a.page.getByPlaceholder("Say something…").inputValue()) === "@Tide ", 'menu: Mention puts "@Tide " in the input');
  // focusChat focuses on the next animation frame, and a software-GL frame can take seconds.
  const focused = await a.page
    .waitForFunction(() => document.activeElement?.id === "chat-input", null, { timeout: 5000 })
    .then(() => true, () => false);
  check(focused, "menu: Mention focuses the input");
  await a.page.getByPlaceholder("Say something…").fill("");
  await a.page.getByPlaceholder("Say something…").press("Escape");
  await a.page.getByRole("button", { name: "Open chat" }).waitFor();

  // 4. Minimize and unread, and the remembered state.
  const stored = (t) => t.page.evaluate(() => localStorage.getItem("emberisle-chat-open"));
  await a.page.getByRole("button", { name: "Open chat" }).click();
  await a.page.getByRole("button", { name: "Minimize chat" }).click();
  check((await stored(a)) === "0", 'minimize: localStorage["emberisle-chat-open"] is "0"');
  // Reduced motion: a closed-chat bubble appears and goes with no animation and no transform, then leaves.
  await openChat(c);
  await a.page.emulateMedia({ reducedMotion: "reduce" });
  await c.page.getByPlaceholder("Say something…").fill("ping");
  await c.page.getByPlaceholder("Say something…").press("Enter");
  const cId = await store(c, () => window.__emberisle.getState().localId);
  const still = a.page.getByTestId(`rail-${cId}`).locator('[data-testid="chat-bubble"] > div');
  await still.waitFor({ timeout: 5000 });
  check(await still.evaluate((el) => el.getAnimations().length === 0 && getComputedStyle(el).opacity === "1" && getComputedStyle(el).transform === "none"), "reduced motion: the closed-chat bubble is fully static");
  await still.waitFor({ state: "detached", timeout: 6000 });
  check(true, "reduced motion: the closed-chat bubble goes after its lifetime, with no movement");
  await a.page.emulateMedia({ reducedMotion: "no-preference" });
  await a.page.getByTestId("chat-unread").waitFor({ timeout: 5000 });
  check((await a.page.getByTestId("chat-unread").textContent()) === "1", "unread: tab 1's badge shows 1");
  // #377: the badge is part of the button's name.
  await a.page.getByRole("button", { name: "Open chat, 1 unread", exact: true }).waitFor({ timeout: 5000 });
  check(true, 'unread: the minimized button is named "Open chat, 1 unread"');
  await a.page.getByRole("button", { name: "Open chat" }).click();
  await a.page.getByTestId("chat-unread").waitFor({ state: "detached" });
  check((await stored(a)) === "1", 'open: badge cleared and the value is "1"');
  await shot(a, "chat-open.jpg");
  const fresh = await a.page.context().newPage();
  watch("Ember2", fresh);
  await fresh.goto(url);
  check(await fresh.evaluate(() => window.__emberisle.getState().chatOpen === true), "a new page in the same browser context starts with chatOpen true");
  await fresh.close();
  await a.page.getByPlaceholder("Say something…").press("Escape");
  await a.page.getByRole("button", { name: "Open chat" }).waitFor();
  check((await stored(a)) === "0", "Esc in the input minimizes the dock");

  // #377: Enter on a focused button presses it; the chat shortcut is only for focus on the page itself.
  const chatOpen = () => a.page.evaluate(() => window.__emberisle.getState().chatOpen);
  // #442: How to play is a row of the table menu; Enter opens the menu, then the row.
  await a.page.getByRole("button", { name: "Table menu" }).focus();
  await a.page.keyboard.press("Enter");
  const how = a.page.getByRole("button", { name: "How to play" });
  await how.focus();
  await a.page.keyboard.press("Enter");
  await a.page.getByRole("dialog", { name: "How to play" }).waitFor({ timeout: 5000 });
  check((await chatOpen()) === false, "Enter on Table menu, then How to play, opens its dialog and leaves the chat closed");
  await a.page.keyboard.press("Escape");
  await a.page.getByRole("dialog", { name: "How to play" }).waitFor({ state: "detached" });
  await a.page.getByRole("button", { name: "Open chat" }).click();
  const log = a.page.getByTestId("chat-log");
  await log.waitFor();
  check((await log.getAttribute("tabindex")) === "0" && (await log.getAttribute("role")) === "log", "the chat log is a focusable role=log");
  const min = a.page.getByRole("button", { name: "Minimize chat" });
  await min.focus();
  await a.page.keyboard.press("Enter");
  await a.page.getByRole("button", { name: "Open chat" }).waitFor({ timeout: 5000 });
  check((await chatOpen()) === false, "Enter on Minimize chat minimizes the dock");
  await a.page.evaluate(() => document.activeElement?.blur());
  await a.page.keyboard.press("Enter");
  await a.page.waitForFunction(() => document.activeElement?.id === "chat-input", null, { timeout: 5000 });
  check(await chatOpen(), "Enter with focus on the page still opens the chat and focuses the input");
  await a.page.getByPlaceholder("Say something…").press("Escape");
  await a.page.getByRole("button", { name: "Open chat" }).waitFor();

  // 5. Phone: the open dock is a bottom sheet, and the tap that closes it does not reach the board.
  await phone.page.getByRole("button", { name: "Open chat" }).waitFor();
  r = await box(phone, '[aria-label^="Open chat"]');
  await polish(phone, "minimized", '[aria-label^="Open chat"]');
  await phone.page.getByRole("button", { name: "Open chat" }).click();
  await phone.page.getByTestId("chat-sheet").waitFor({ timeout: 5000 });
  check(await phone.page.getByTestId("chat-sheet").evaluate((el) => el.classList.contains("px-safe")), "phone: the chat sheet uses the shared horizontal safe-area utility");
  r = await box(phone, '[aria-label="Table chat"]');
  const cap = Math.min(r.vh - 80, 420);
  check(Math.abs(r.bottom - r.vh) < 1 && r.left === 0 && Math.abs(r.width - r.vw) < 1, `phone: chat is a sheet at the bottom, ${r.width.toFixed(0)} px wide of ${r.vw}`);
  check(r.height > 100 && r.height <= cap + 0.5, `phone: the sheet is ${r.height.toFixed(0)} px tall, at most min(100dvh − 80px, 420px) = ${cap.toFixed(0)}`);
  const lay = await phone.page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="chat-sheet"]').getBoundingClientRect();
    const head = document.querySelector('[data-testid="chat-sheet-header"]').getBoundingClientRect();
    const log = document.querySelector('[data-testid="chat-log"]');
    const input = document.getElementById("chat-input").getBoundingClientRect();
    return { sheetBottom: sheet.bottom, headBottom: head.bottom, logTop: log.getBoundingClientRect().top, inputBottom: input.bottom, atEnd: log.scrollHeight - log.scrollTop - log.clientHeight < 2 };
  });
  check(lay.sheetBottom - lay.inputBottom <= 24, `phone: the input row ends ${(lay.sheetBottom - lay.inputBottom).toFixed(0)} px above the sheet bottom, no dead space`);
  check(lay.logTop >= lay.headBottom && lay.atEnd, "phone: the log starts below the header and shows the newest line");
  await polish(phone, "open on the Chat tab", undefined, 12);
  // #899: the sheet ends below the seat strip and the bubbles under it, on both tabs. Tide reacts, so a live bubble is measured.
  const sheetClear = async (tab) => {
    await b.page.evaluate(() => window.__emberisle.getState().sendReact("👏"));
    const bubble = phone.page.getByTestId(`seat-${await store(b, () => window.__emberisle.getState().localId)}`).locator('[data-testid="reaction"][data-emote="👏"] > div');
    await bubble.waitFor({ timeout: 5000 });
    const m = await bubble.evaluate((el) => {
      const sheet = document.querySelector('[data-testid="chat-sheet"]').getBoundingClientRect();
      const strip = document.querySelector('[data-testid="seat-strip"]').getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return { sheet: Math.round(sheet.top), strip: Math.round(strip.bottom), bubble: Math.round(b.bottom) };
    });
    check(m.sheet >= m.strip && m.sheet >= m.bubble, `phone ${tab} tab: the sheet (top ${m.sheet}) leaves the seat strip (bottom ${m.strip}) and the seat bubble (bottom ${m.bubble}) clear`);
  };
  await sheetClear("Chat");
  await showTab(phone, "Sounds & stickers");
  await polish(phone, "open on the Sounds & stickers tab", undefined, 13);
  const phoneBoard = await phone.page.getByTestId("soundboard").evaluate((el, legacyLabels) => {
    const sheet = document.querySelector('[data-testid="chat-sheet"]').getBoundingClientRect();
    const buttons = [...el.querySelectorAll("button")];
    const chips = buttons.map((b) => b.getBoundingClientRect());
    return { n: buttons.filter((button) => legacyLabels.includes(button.getAttribute("aria-label"))).length, total: buttons.length, wide: el.scrollWidth > el.clientWidth + 0.5, inside: chips.every((r) => r.left >= sheet.left && r.right <= sheet.right && r.bottom <= sheet.bottom), font: parseFloat(getComputedStyle(el.querySelector("button")).fontSize) };
  }, ["Play sound Fah", "Play sound Wololo", "Play sound GG!", "Play sound Airhorn", "Play sound Quit touchin' me", "Play sound Wood please", "Play sound Perfect", "Play sound Bong"]);
  check(phoneBoard.n === 8 && !phoneBoard.wide && phoneBoard.inside && phoneBoard.font >= 14, `phone: Sounds & stickers shows all 8 listed chips at ${phoneBoard.font}px, inside the sheet, with no sideways scroll`);
  check(phoneBoard.total === 15 && !phoneBoard.wide && phoneBoard.inside, `phone: Sounds & stickers shows all 15 chips inside the sheet, with no sideways scroll`);
  await sheetClear("Sounds & stickers");
  await shot(phone, "chat-phone-sounds.jpg");
  await showTab(phone, "Chat");
  await shot(phone, "chat-phone-open.jpg");
  const before = await phone.page.evaluate(() => {
    const s = window.__emberisle.getState();
    const v = s.state.current === s.localId ? s.legal?.outpost?.[0] : null;
    const at = v ? window.__isle.screenOf(v) : null;
    return { seq: s.state.seq, at: at ?? { x: 195, y: 200 } };
  });
  await phone.page.touchscreen.tap(before.at.x, before.at.y);
  await phone.page.getByTestId("chat-sheet").waitFor({ state: "detached", timeout: 5000 });
  const after = await phone.page.evaluate(() => ({ seq: window.__emberisle.getState().state.seq, pending: window.__emberisle.getState().pendingPlace }));
  check(after.seq === before.seq && !after.pending, "phone: tapping the board with the sheet open only closes it, no piece or selection");

  // Phone menu (#161): a strip chip opens it under the strip with 44 px items, and Mention opens the sheet with the draft.
  const aId = await store(a, () => window.__emberisle.getState().localId);
  await phone.page.getByTestId(`seat-${aId}`).getByRole("button").tap();
  const pMenu = phone.page.getByTestId("player-menu");
  await pMenu.waitFor({ timeout: 5000 });
  const pGeo = await phone.page.evaluate(() => {
    const strip = document.querySelector('[data-testid="seat-strip"]').getBoundingClientRect();
    const menu = document.querySelector('[data-testid="player-menu"]').getBoundingClientRect();
    const items = [...document.querySelectorAll('[data-testid="player-menu"] button')].map((b) => b.getBoundingClientRect());
    return { under: menu.top >= strip.bottom, onScreen: menu.left >= 0 && menu.right <= innerWidth && menu.bottom <= innerHeight, items: items.length, small: items.filter((r) => r.width < 44 || r.height < 44).length };
  });
  check(pGeo.under && pGeo.onScreen, "phone: the menu opens downward from the strip, on screen");
  check(pGeo.items > 0 && pGeo.small === 0, `phone: all ${pGeo.items} menu items are at least 44 px on both axes`);
  await shot(phone, "chat-phone-menu.jpg");
  await pMenu.getByRole("button", { name: "Mention @Ember in chat" }).tap();
  await pMenu.waitFor({ state: "detached" });
  await phone.page.getByTestId("chat-sheet").waitFor({ timeout: 5000 });
  check((await phone.page.getByPlaceholder("Say something…").inputValue()) === "@Ember ", 'phone: Mention opens the sheet with "@Ember "');
  await phone.page.setViewportSize({ width: 667, height: 375 });
  const shortLandscape = await phone.page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="chat-sheet"]').getBoundingClientRect();
    const header = document.querySelector('[data-testid="chat-sheet-header"]').getBoundingClientRect();
    const mute = document.querySelector('[data-testid="chat-mute-toggle"]').getBoundingClientRect();
    const minimize = document.querySelector('button[aria-label="Minimize chat"]').getBoundingClientRect();
    const input = document.getElementById("chat-input").getBoundingClientRect();
    const paddingBottom = Number.parseFloat(getComputedStyle(document.querySelector('[data-testid="chat-sheet"]')).paddingBottom) || 0;
    return {
      width: innerWidth,
      height: innerHeight,
      sheetBottom: sheet.bottom,
      paddingBottom,
      inputBottom: input.bottom,
      header: { top: header.top, bottom: header.bottom },
      mute: { top: mute.top, bottom: mute.bottom, right: mute.right },
      minimize: { top: minimize.top, bottom: minimize.bottom, left: minimize.left },
    };
  });
  const actionsInHeader =
    shortLandscape.mute.top >= shortLandscape.header.top && shortLandscape.mute.bottom <= shortLandscape.header.bottom &&
    shortLandscape.minimize.top >= shortLandscape.header.top && shortLandscape.minimize.bottom <= shortLandscape.header.bottom &&
    shortLandscape.minimize.left >= shortLandscape.mute.right && shortLandscape.minimize.left - shortLandscape.mute.right <= 8;
  check(actionsInHeader, "phone 667x375: Mute sits beside Minimize in the header");
  check(
    shortLandscape.inputBottom <= shortLandscape.sheetBottom - shortLandscape.paddingBottom + 1 && shortLandscape.inputBottom <= shortLandscape.height - shortLandscape.paddingBottom + 1,
    `phone 667x375: chat input clears the bottom safe padding (${shortLandscape.paddingBottom}px)`,
  );
  await phone.page.getByRole("button", { name: "Minimize chat" }).tap();
  await phone.page.setViewportSize({ width: 390, height: 844 });

  // 7. The game log (#305): setup and the first roll through the store, then every dock lists the game's lines as muted
  // rows in with the chat, the Chat chip hides them, and Copy log puts the whole log on the clipboard.
  const all = [...tabs, phone];
  const act = (t, fn, arg) => t.page.evaluate(([f, a]) => window.__emberisle.getState()[f](...[].concat(a)), [fn, arg]);
  const seen = (t) =>
    store(t, () => {
      const s = window.__emberisle.getState();
      return { you: s.localId, current: s.state.current, phase: s.state.phase, seq: s.state.seq, dice: s.state.dice, outpost: s.legal?.outpost ?? [], path: s.legal?.path ?? [] };
    });
  const tabForTurn = (ownTurn) =>
    until(async () => {
      const states = await Promise.all(all.map(seen));
      const current = states[0].current;
      if (states.some((state) => state.phase !== "roll" || state.current !== current)) return null;
      const index = states.findIndex((state) => (state.current === state.you) === ownTurn);
      return index < 0 ? null : all[index];
    }, `a consistent ${ownTurn ? "current" : "other"} player's roll view`);
  const byId = {};
  for (const t of all) byId[(await seen(t)).you] = t;
  for (let step = 0; step < 16; step++) {
    const v = await seen(a);
    if (v.phase === "roll") break;
    const t = byId[v.current];
    const mine = await until(async () => {
      const m = await seen(t);
      return m.seq === v.seq && (m.phase === "setupSettle" ? m.outpost.length : m.path.length) ? m : null;
    }, `${t.name} has its glow for setup step ${step}`);
    if (mine.phase === "setupSettle") await act(t, "pickVertex", mine.outpost[0]);
    else await act(t, "pickEdge", mine.path[0]);
    await until(async () => ((await seen(a)).seq > v.seq ? true : null), `setup step ${step} reaches Ember`);
  }
  const atRoll = await seen(a);
  check(atRoll.phase === "roll", `game log: setup is done, phase ${atRoll.phase}`);

  // #501: chat history from a started game is restored by the existing welcome.chat rejoin path.
  const historyLines = [`reload-history-a-${Date.now()}`, `reload-history-c-${Date.now()}`];
  await a.page.evaluate((text) => window.__emberisle.getState().sendChat(text), historyLines[0]);
  await c.page.evaluate((text) => window.__emberisle.getState().sendChat(text), historyLines[1]);
  const bSeat = await store(b, () => window.__emberisle.getState().seatId);
  await b.page.waitForFunction((texts) => texts.every((text) => window.__emberisle.getState().chat.some((line) => line.text === text)), historyLines);
  await b.page.reload();
  await b.page.waitForFunction(({ seat, texts }) => {
    const s = window.__emberisle.getState();
    return s.seatId === seat && s.state?.phase === "roll" && texts.every((text) => s.chat.some((line) => line.text === text));
  }, { seat: bSeat, texts: historyLines });
  if (!(await store(b, () => window.__emberisle.getState().chatOpen))) {
    await b.page.getByRole("button", { name: /^Open chat/ }).click();
  }
  for (const line of historyLines) await b.page.getByTestId("chat-log").locator("li", { hasText: line }).waitFor();
  for (const line of historyLines) {
    const shown = await b.page.getByTestId("chat-log").locator("li", { hasText: line }).count();
    const stored = await b.page.evaluate((text) => window.__emberisle.getState().chat.filter((l) => l.text === text).length, line);
    check(shown === 1 && stored === 1, `chat history: after the reload "${line}" shows exactly once (log ${shown}, store ${stored})`);
  }
  check(true, "chat history: Tide reloads mid-game in the same seat and sees earlier chat lines");

  // #477, #899: Open chat, the one chat button, sits in the top row beside the Table menu, a place that depends on neither the turn nor the
  // HUD stack. At each phone size, with the notch insets emulated over CDP as hud-safe-area-prove does, on your own Roll turn and
  // another seat's turn: it is 44 px, whole and inside the safe area, clear of the Table menu, the seat strip and the
  // status line, at least 12 px from every on-screen vertex, edge and hex, and at the same y on both turns. The board is read
  // with the camera settled (no glide, no refit due) and the projection unchanged between two reads.
  const DOCK_SIZES = [
    { width: 390, height: 844, insets: { top: 47, right: 0, bottom: 34, left: 0 } },
    { width: 360, height: 640, insets: { top: 24, right: 0, bottom: 24, left: 0 } },
    { width: 844, height: 390, insets: { top: 0, right: 47, bottom: 21, left: 47 } },
  ];
  const SLOP = 12;
  const dockFailures = [];
  const dockTop = new Map();
  const dockSample = (t) =>
    t.page.evaluate(() => {
      const i = window.__isle;
      const st = window.__emberisle.getState().state;
      if (!i?.lastState || i.lastSeq !== st.seq || i.refitDue || i.glide) return null;
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      const extra = document.querySelectorAll('button[aria-label="Quick reactions"], button[aria-label="Soundboard"], button[aria-label="Emotes"]').length;
      const chat = rect(document.querySelector('button[aria-label^="Open chat"]'));
      const menu = rect(document.querySelector('button[aria-label="Table menu"]'));
      if (!chat || !menu) return null;
      const status = ["seat-strip", "banner", "turn-banner", "watching-badge"].flatMap((id) => {
        const r = rect(document.querySelector(`[data-testid="${id}"]`));
        return r ? [{ id, ...r }] : [];
      });
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
      document.body.append(probe);
      const cs = getComputedStyle(probe);
      const env = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat);
      probe.remove();
      const targets = [...st.vertices, ...st.edges, ...st.hexes].flatMap(({ id }) => {
        const p = i.screenOf(id);
        return p && p.x >= 0 && p.y >= 0 && p.x <= innerWidth && p.y <= innerHeight ? [{ id, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }] : [];
      });
      const header = rect(document.querySelector("header.hud-header"));
      return { vw: innerWidth, vh: innerHeight, env, extra, chat, menu, status, targets, header, coarse: matchMedia("(pointer: coarse)").matches };
    });
  const dockLayout = async (t) => {
    let last = "";
    return until(async () => {
      const m = await dockSample(t);
      const key = m ? JSON.stringify(m.targets) : "";
      const stable = m && key === last;
      last = key;
      return stable ? m : null;
    }, "the camera settles with a stable projection", 30_000);
  };
  const phoneLayout = async (t, ownTurn, checkBanner = false) => {
    const state = await seen(t);
    check(state.phase === "roll" && (state.current === state.you) === ownTurn, `chat dock: ${ownTurn ? "own" : "another seat's"} turn is available for the layout check`);
    if (await store(t, () => window.__emberisle.getState().chatOpen)) await t.page.getByRole("button", { name: "Minimize chat" }).click();
    const roll = t.page.getByRole("button", { name: "Roll", exact: true });
    const turn = ownTurn ? "own Roll turn" : "another seat's turn";
    const cdp = await t.page.context().newCDPSession(t.page);
    // #520: these are phone sizes, so run them with touch emulation (a coarse pointer), not at desktop pointer settings. 844 px
    // wide is the one that only counts as a phone through the pointer.
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    for (const size of DOCK_SIZES) {
      const tag = `${size.width}x${size.height}, ${turn}`;
      await t.page.setViewportSize({ width: size.width, height: size.height });
      await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: size.insets });
      if (ownTurn) await roll.waitFor({ state: "visible" });
      else if (await roll.count()) dockFailures.push(`${tag}: Roll is showing on another seat's turn`);
      const m = await dockLayout(t);
      const want = [size.insets.top, size.insets.right, size.insets.bottom, size.insets.left];
      const bad = (what) => dockFailures.push(`${tag}: ${what}`);
      if (m.vw !== size.width || m.vh !== size.height || m.env.some((v, i) => v !== want[i])) bad(`the viewport or inset emulation did not take (${m.vw}x${m.vh}, env ${m.env})`);
      const safe = { left: size.insets.left, top: size.insets.top, right: size.width - size.insets.right, bottom: size.height - size.insets.bottom };
      const hit = (a, b) => a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
      if (!m.coarse) bad("touch emulation did not give a coarse pointer");
      const strip = m.status.find((x) => x.id === "seat-strip");
      // Sideways, the strip shares the header row with Open chat; upright it sits under the header, so only landscape is asserted.
      if (!strip) bad("no seat strip on screen");
      else if (size.width > size.height && (strip.left < m.header.left - 0.5 || strip.right > m.header.right + 0.5 || strip.top < m.header.top - 0.5 || strip.bottom > m.header.bottom + 0.5)) bad(`the seat strip is not inside the header ${JSON.stringify(strip)} vs ${JSON.stringify(m.header)}`);
      if (m.extra) bad(`${m.extra} separate reaction, soundboard or smile buttons are showing; Open chat is the one button`);
      for (const [name, r] of [["Open chat", m.chat]]) {
        if (r.right - r.left < 44 - 0.5 || r.bottom - r.top < 44 - 0.5) bad(`${name} is ${(r.right - r.left).toFixed(0)}x${(r.bottom - r.top).toFixed(0)}, under 44 px`);
        if (r.left < safe.left || r.top < safe.top || r.right > safe.right || r.bottom > safe.bottom) bad(`${name} is not fully inside the safe area ${JSON.stringify(r)}`);
        if (hit(r, m.menu)) bad(`${name} overlaps the Table menu ${JSON.stringify(r)} vs ${JSON.stringify(m.menu)}`);
        for (const sx of m.status) if (hit(r, sx)) bad(`${name} overlaps ${sx.id} ${JSON.stringify(r)} vs ${JSON.stringify(sx)}`);
        const near = m.targets.filter((p) => p.x > r.left - SLOP && p.x < r.right + SLOP && p.y > r.top - SLOP && p.y < r.bottom + SLOP);
        if (near.length) bad(`${near.length} board targets within ${SLOP} px of ${name} ${JSON.stringify(r)}: ${JSON.stringify(near.slice(0, 4))}`);
      }
      const key = `${size.width}x${size.height}`;
      const mine = { top: Math.round(m.chat.top * 10) / 10, left: Math.round(m.chat.left * 10) / 10 };
      const other = dockTop.get(key);
      if (other !== undefined) {
        if (Math.abs(other.top - mine.top) > 0.5 || Math.abs(other.left - mine.left) > 0.5) bad(`the button moved between turns: ${JSON.stringify(other)} before, ${JSON.stringify(mine)} now`);
      } else dockTop.set(key, mine);
      console.log(`dock ${tag}: ${m.targets.length} targets, Open chat x ${m.chat.left.toFixed(0)}-${m.chat.right.toFixed(0)}, y ${m.chat.top.toFixed(0)}-${m.chat.bottom.toFixed(0)}, Table menu x ${m.menu.left.toFixed(0)}-${m.menu.right.toFixed(0)}`);
      // #899: Open chat is the one button; the panel it opens has the emoji, whole and inside the safe area, below the button.
      await t.page.getByRole("button", { name: /^Open chat/ }).click();
      await t.page.getByTestId("emoji-row").waitFor();
      const row = await t.page.getByTestId("emoji-row").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
      if (row.left < safe.left || row.right > safe.right || row.top < m.chat.bottom || row.bottom > safe.bottom) bad(`the panel's emoji row is not inside the safe area, below the button ${JSON.stringify(row)}`);
      await t.page.getByRole("button", { name: "Minimize chat" }).click();
      await t.page.getByRole("button", { name: /^Open chat/ }).waitFor();
      if (checkBanner && size.width === 390) {
        await t.page.evaluate(() => window.__emberisle.setState({ banner: "Ember's roll · Ember +2 timber · Ember +1 grain · Pine +2 timber · Pine +1 grain · Tide +2 timber · Tide +1 grain · Moss +2 timber · Moss +1 grain · bank short of timber and grain" }));
        await t.page.getByTestId("banner").waitFor();
        const shown = await dockLayout(t);
        const banner = shown.status.find((x) => x.id === "banner");
        if (!banner || banner.bottom - banner.top < 90) bad("a multi-seat roll status did not wrap to four lines");
        if (banner && hit(shown.chat, banner)) bad("Open chat overlaps the visible status banner");
        if (Math.abs(shown.chat.top - m.chat.top) > 0.5 || Math.abs(shown.chat.left - m.chat.left) > 0.5) bad("showing the status banner moved the button");
        await t.page.evaluate(() => window.__emberisle.setState({ banner: null }));
        await t.page.waitForFunction(() => !document.querySelector('[data-testid="banner"]'));
      }
    }
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, right: 0, bottom: 0, left: 0 } });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  };
  const ownTab = await tabForTurn(true);
  const otherTab = await tabForTurn(false);
  const originalViewports = new Map([ownTab, otherTab].map((t) => [t, t.page.viewportSize()]));
  await phoneLayout(ownTab, true, true);
  await phoneLayout(otherTab, false);
  check(dockFailures.length === 0, `chat dock: top-row buttons at 390x844, 360x640 and 844x390, own and another seat's turn${dockFailures.length ? `\n${dockFailures.join("\n")}` : ""}`);
  for (const [t, viewport] of originalViewports) {
    if (viewport) await t.page.setViewportSize(viewport);
  }
  await act(await tabForTurn(true), "dispatch", [{ type: "roll" }]);
  await until(async () => ((await seen(a)).dice ? true : null), "the first roll reaches Ember");
  const rowsOf = (t) => t.page.getByTestId("chat-log").getByTestId("log-row").allTextContents();
  for (const t of all) {
    if (await t.page.getByRole("button", { name: "Open chat" }).count()) await t.page.getByRole("button", { name: "Open chat" }).click();
    const rows = await until(async () => {
      const r = await rowsOf(t);
      return r.length >= 3 && r.some((x) => / — .+'s roll[;.]/.test(x)) && r.some((x) => /raises an outpost|founds an outpost/.test(x)) ? r : null;
    }, `${t.name} lists the roll and an outpost in the game log`);
    check(true, `game log: ${t.name} shows ${rows.length} rows, with the roll and an outpost${t === phone ? ", in the phone sheet" : ""}`);
  }
  await b.page.getByPlaceholder("Say something…").fill("@Ember polish");
  await b.page.getByPlaceholder("Say something…").press("Enter");
  await a.page.getByTestId("chat-log").locator("mark").getByText("@Ember", { exact: true }).waitFor();
  await a.page.getByTestId("emoji-row").waitFor();
  await polish(a, "open with the emoji and a mention", undefined, 12);
  await showTab(a, "Sounds & stickers");
  await polish(a, "Sounds & stickers tab", undefined, 13);
  const deskBoard = await a.page.getByTestId("soundboard").evaluate((el) => {
    const panel = document.querySelector('section[aria-label="Table chat"]').getBoundingClientRect();
    const rail = document.querySelector("aside").getBoundingClientRect();
    const chips = [...el.querySelectorAll("button")];
    const wide = el.scrollWidth > el.clientWidth + 0.5;
    const inPanel = chips.every((button) => {
      button.scrollIntoView({ block: "nearest" });
      const r = button.getBoundingClientRect();
      return r.left >= panel.left && r.right <= panel.right && r.bottom <= panel.bottom;
    });
    const legacyLabels = ["Play sound Fah", "Play sound Wololo", "Play sound GG!", "Play sound Airhorn", "Play sound Quit touchin' me", "Play sound Wood please", "Play sound Perfect", "Play sound Bong"];
    return { n: chips.filter((button) => legacyLabels.includes(button.getAttribute("aria-label"))).length, total: chips.length, wide, inside: inPanel, font: parseFloat(getComputedStyle(el.querySelector("button")).fontSize), clearOfRail: panel.left >= rail.right + 100 };
  });
  check(deskBoard.n === 8 && !deskBoard.wide && deskBoard.inside && deskBoard.font >= 14 && deskBoard.clearOfRail, `desktop: Sounds & stickers shows all 8 listed chips at ${deskBoard.font}px with no sideways scroll, in a panel clear of the seat rail`);
  check(deskBoard.total === 15 && !deskBoard.wide && deskBoard.inside && deskBoard.clearOfRail, `desktop: Sounds & stickers shows all 15 chips with no sideways scroll, in a panel clear of the seat rail`);
  await shot(a, "chat-desktop-sounds.jpg");
  await showTab(a, "Chat");
  // The panel remembers the last tab: a page reload in the same browser starts on it.
  check((await a.page.evaluate(() => localStorage.getItem("emberisle-chat-tab"))) === "chat", 'tabs: the panel remembers the last tab ("chat")');
  // #899 (owner decision): the Chat tab has no Chat / All / Copy log row. It always lists the game rows with the chat, and
  // Copy log is a plain row in the Table menu.
  const shown = await until(async () => {
    const r = await rowsOf(a);
    return r.length >= 3 ? r : null;
  }, "the Chat tab lists the game rows");
  const dockRow = await a.page.evaluate(() => {
    const sec = document.querySelector('section[aria-label="Table chat"]');
    return { filters: sec.querySelectorAll(".chat-filters, [aria-pressed]").length, buttons: [...sec.querySelectorAll("button:not([role=tab])")].map((b) => b.textContent.trim()).filter((t) => ["Chat", "All", "Copy log", "Copied"].includes(t)) };
  });
  check(dockRow.filters === 0 && dockRow.buttons.length === 0 && (await a.page.getByTestId("chat-log").locator("li", { hasText: "hello" }).count()) === 1, `game log: no Chat / All / Copy log row in the dock (${JSON.stringify(dockRow)}); the log keeps the chat lines and ${shown.length} game rows`);
  await polish(a, "Chat tab without the filter row", undefined, 12);
  const menuCopyLog = async (t) => {
    await t.page.getByRole("button", { name: "Table menu", exact: true }).click();
    await t.page.getByRole("dialog", { name: "Table menu" }).getByRole("button", { name: "Copy log", exact: true }).click();
  };
  await a.page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await menuCopyLog(a);
  await a.page.getByRole("dialog", { name: "Table menu" }).getByRole("button", { name: "Copied", exact: true }).waitFor({ timeout: 5000 });
  const copied = await a.page.evaluate(() => navigator.clipboard.readText());
  const wanted = await store(a, () => window.__emberisle.getState().gameLog.map((l) => l.text).join("\n"));
  check(copied === wanted && copied.split("\n").length === shown.length, `game log: Copy log in the Table menu copies all ${shown.length} rows`);
  await shot(a, "chat-game-log.jpg");
  await a.page.keyboard.press("Escape");
  await a.page.getByRole("dialog", { name: "Table menu" }).waitFor({ state: "detached" });
  // #343: with no clipboard (a LAN address over plain http) Copy log shows the log in a read-only field, focused and selected.
  await a.page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
  await menuCopyLog(a);
  const fallback = await a.page
    .waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="copy-fallback"]');
        if (!el || document.activeElement !== el) return null;
        return { value: el.value, readOnly: el.readOnly, selected: el.selectionStart === 0 && el.selectionEnd === el.value.length, live: document.querySelector('[data-testid="copy-status"]')?.textContent, inMenu: !!el.closest('[role="dialog"]') };
      },
      null,
      { timeout: 5000 },
    )
    .then((h) => h.jsonValue());
  check(fallback.value === wanted && fallback.readOnly && fallback.selected && fallback.live === "Select and copy" && fallback.inMenu, "game log: without a clipboard, the Table menu's Copy log shows the log in a focused, selected read-only field and says so");
  await a.page.keyboard.press("Escape");
  await a.page.getByRole("dialog", { name: "Table menu" }).waitFor({ state: "detached" });
  await phone.page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
  if (await store(phone, () => window.__emberisle.getState().chatOpen)) await phone.page.getByRole("button", { name: "Minimize chat" }).click();
  await menuCopyLog(phone);
  await phone.page.getByTestId("copy-fallback").waitFor();
  check((await phone.page.getByTestId("copy-fallback").inputValue()) === (await store(phone, () => window.__emberisle.getState().gameLog.map((l) => l.text).join("\n"))), "game log: on the phone the Table menu's Copy log shows the whole log");
  await phone.page.keyboard.press("Escape");
  await phone.page.getByRole("dialog", { name: "Table menu" }).waitFor({ state: "detached" });

  // A real watcher exposes the muted read-only note, and Copy log from the Table menu, at both sizes.
  for (const isPhone of [false, true]) {
    const reader = await tab("Reader", isPhone);
    await reader.page.getByPlaceholder(/code/i).fill(tableCode);
    await reader.page.getByRole("button", { name: "Watch", exact: true }).click();
    await reader.page.getByRole("button", { name: "Open chat" }).click();
    await reader.page.getByTestId("chat-readonly").waitFor();
    check(await reader.page.getByTestId("emoji-row").count() === 0 && await reader.page.getByRole("tab").count() === 0 && await reader.page.getByRole("button", { name: /^(React |Play sound |Quick reactions)/ }).count() === 0, `chat panel: ${isPhone ? "phone" : "desktop"} watcher has no emoji, tabs, sounds or stickers`);
    const refused = await reader.page.evaluate((code) => new Promise((resolve, reject) => {
      const socket = new WebSocket(new URLSearchParams(location.search).get("host"));
      const frames = [];
      const timer = setTimeout(() => { socket.close(); reject(new Error("watcher reaction rejection timed out")); }, 5000);
      socket.onopen = () => socket.send(JSON.stringify({ type: "hello", code, watch: true }));
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        frames.push(message);
        if (message.type === "welcome" && message.spectator) socket.send(JSON.stringify({ type: "react", emote: "😊" }));
        if (message.type === "error") socket.close();
      };
      socket.onerror = () => { clearTimeout(timer); reject(new Error("watcher proof socket failed")); };
      socket.onclose = () => {
        clearTimeout(timer);
        resolve(frames.some((m) => m.type === "error" && m.message === "Watching only.") && !frames.some((m) => m.type === "react"));
      };
    }), tableCode);
    check(refused, "quick reactions: host rejects an allowlisted emoji forged by a watcher");
    // Mute and Minimize are the watcher's only controls in the dock (#899: the filter row is gone).
    await polish(reader, "read-only", undefined, 2);
    check((await reader.page.locator('section[aria-label="Table chat"] [aria-pressed]').count()) === 0 && (await reader.page.getByTestId("chat-log").getByTestId("log-row").count()) > 0, `watcher ${isPhone ? "phone" : "desktop"}: no filter row, and the log lists the game rows`);
    await reader.page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
    if (await store(reader, () => window.__emberisle.getState().chatOpen)) await reader.page.getByRole("button", { name: "Minimize chat" }).click();
    await menuCopyLog(reader);
    await reader.page.getByTestId("copy-fallback").waitFor();
    check(await reader.page.getByTestId("copy-fallback").evaluate((el) => el.readOnly && el.value.length > 0), `watcher ${isPhone ? "phone" : "desktop"}: the Table menu's Copy log shows the log to copy`);
    await reader.page.context().close();
  }

  // Versus bots the menu shows only the facts (and the bank trade on your main turn, not during setup).
  const { page: solo } = await tab("Solo");
  await solo.getByRole("button", { name: "Play", exact: true }).click();
  // The human rolls off (#232) when it is up; the bots roll on the app's timer.
  await solo.waitForFunction(() => {
    const s = window.__emberisle.getState();
    if (s.state?.phase === "rollOff" && s.state.current === s.localId) s.dispatch({ type: "roll" });
    return s.state?.phase === "setupSettle";
  }, null, { polling: 100, timeout: 60_000 });
  await solo.getByTestId("rail-p1").getByRole("button").click();
  await solo.getByTestId("player-menu").waitFor();
  check(
    (await solo.getByTestId("menu-facts").locator("dd").count()) === 4 && (await solo.getByTestId("score-breakdown").locator("dd").count()) === 4 && (await solo.getByTestId("player-menu").locator("button").count()) === 0,
    "bots: the menu shows four facts, four public score components and no seat actions",
  );
  await solo.context().close();

  // Chat is readable on a phone in a game: an unread line shows without opening the dock, the open sheet shows at least four whole
  // lines of 14 px or more with the newest in view, and the map is not refitted by opening or closing it.
  await phone.page.setViewportSize({ width: 440, height: 956 });
  if (await phone.page.getByTestId("chat-sheet").count()) await phone.page.getByRole("button", { name: "Minimize chat" }).click();
  await phone.page.getByRole("button", { name: /^Open chat/ }).waitFor();
  for (const i of [1, 2, 3, 4, 5, 6]) await SAY(a, `game line ${i}`);
  await until(async () => (await phone.page.getByTestId("chat-unread").textContent().catch(() => "")) === "6", "Moss's badge counts six unread lines");
  // #899 (owner decision): with the sheet closed the newest line is a bubble under Ember's strip cell, not a preview pill.
  const aPlayer = await store(a, () => window.__emberisle.getState().localId);
  await phone.page.getByTestId(`seat-${aPlayer}`).getByTestId("chat-bubble").filter({ hasText: "game line 6" }).waitFor({ timeout: 5000 });
  check((await phone.page.getByTestId("chat-preview").count()) === 0 && (await phone.page.getByTestId("chat-unread-preview").count()) === 0, "phone game: the newest unread line bubbles at the sender's strip cell; no preview pill shows");
  const holeBefore = await hole(phone);
  await shot(phone, "chat-game-closed-440x956.jpg");
  await phone.page.getByRole("button", { name: "Open chat, 6 unread", exact: true }).click();
  await phone.page.getByTestId("chat-sheet").waitFor();
  await new Promise((r) => setTimeout(r, 800));
  check((await phone.page.getByTestId("chat-unread").count()) === 0, "phone game: opening the chat clears the unread badge");
  for (const [w, h] of [[440, 956], [390, 844], [956, 440]]) {
    await phone.page.setViewportSize({ width: w, height: h });
    if (!(await phone.page.getByTestId("chat-sheet").count())) await phone.page.getByRole("button", { name: /^Open chat/ }).click();
    await phone.page.getByTestId("chat-sheet").waitFor();
    await until(async () => (await logView(phone)).newest, `${w}x${h} phone game: log scrolled to newest line`, 3000).catch(() => {});
    const v = await logView(phone);
    check(v.whole >= 4 && v.newest && v.newestText.includes("game line 6") && v.font >= 14, `phone game ${v.size} ${JSON.stringify(v)}: ${v.whole} whole chat lines on screen, newest ("${v.newestText.trim()}") visible, ${v.font}px text`);
    if (w === 440) await shot(phone, "chat-game-440x956.jpg");
    // #899: at every size and on both tabs the sheet starts below the seat strip and the 56 px bubble band under it (16 px gap, 40 px bubble).
    for (const tab of ["Sounds & stickers", "Chat"]) {
      await showTab(phone, tab);
      const g = await phone.page.evaluate(() => ({ sheet: document.querySelector('[data-testid="chat-sheet"]').getBoundingClientRect().top, strip: document.querySelector('[data-testid="seat-strip"]').getBoundingClientRect().bottom }));
      check(g.sheet >= g.strip + 56, `phone game ${w}x${h} ${tab} tab: the sheet (top ${Math.round(g.sheet)}) leaves the seat strip (bottom ${Math.round(g.strip)}) and its bubble band clear`);
    }
    check((await phone.page.getByRole("button", { name: "Minimize chat" }).textContent()).trim() === "Close", `phone game ${v.size}: the sheet has a labelled Close`);
  }
  await phone.page.setViewportSize({ width: 440, height: 956 });
  await new Promise((r) => setTimeout(r, 700));
  check((await hole(phone)) === holeBefore, `phone game: the map's hole is the same with the chat open (${holeBefore})`);
  await phone.page.getByRole("button", { name: "Minimize chat" }).click();
  await new Promise((r) => setTimeout(r, 700));
  check((await hole(phone)) === holeBefore, "phone game: and the same again after it is closed");

  // The 844x390 board reaction shares the top-menu edge. The menu and its Leave question stay above it.
  if (await phone.page.getByRole("button", { name: "Minimize chat" }).count()) {
    await phone.page.getByRole("button", { name: "Minimize chat" }).click();
  }
  await phone.page.setViewportSize({ width: 844, height: 390 });
  await phone.page.getByRole("button", { name: /^Open chat/ }).waitFor();
  await phone.page.getByRole("button", { name: "Table menu", exact: true }).tap();
  const tableMenu = phone.page.getByRole("dialog", { name: "Table menu" });
  await tableMenu.waitFor();
  await tableMenu.getByRole("button", { name: "Leave table" }).tap();
  const leaveConfirm = phone.page.getByTestId("leave-confirm");
  const leave = leaveConfirm.getByRole("button", { name: "Leave", exact: true });
  await leave.waitFor();
  const onTop = await leave.evaluate((button) => {
    const r = button.getBoundingClientRect();
    const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return target === button || button.contains(target);
  });
  check(onTop, "landscape phone: the Table menu Leave action is topmost above Open chat at 844x390");
  await leave.tap();
  await phone.page.waitForFunction(() => window.__emberisle.getState().screen === "title");

  // 6.
  check(polishFailures.length === 0, `chat polish at both sizes${polishFailures.length ? `\n${polishFailures.join("\n")}` : ""}`);
  check(errors.length === 0, "zero console errors in all tabs");
  console.log("chat prove ok");
} catch (e) {
  console.log("FAIL", e.message);
  if (errors.length) console.log(errors.join("\n"));
  code = 1;
} finally {
  await browser.close();
  await vite.close();
  host.kill();
  if (host.exitCode === null && host.signalCode === null) await Promise.race([once(host, "exit"), new Promise((r) => setTimeout(r, 3000).unref())]);
}
process.exit(code);
