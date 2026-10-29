// Open-table list for server/host.mjs (#833).
// Any number of open tables may be listed at once (#944); host.mjs lets each player hold one live host seat.
// Only { code, name, seated, status } is ever published — private table codes are never exposed.

const openRooms = new Set();

/** Lists a room its host marked open. Always true: there is no host-wide single slot any more (#944). */
export function registerOpenTable(room) {
  openRooms.add(room);
  return true;
}

export function unregisterOpenTable(room) {
  openRooms.delete(room);
}

/** Drop the open listing when the game ends or nobody is connected. */
export function maybeReleaseOpenSlot(room) {
  if (!openRooms.has(room)) return;
  if (room.game?.phase === "over" || !room.seats.some((s) => s.ws)) unregisterOpenTable(room);
}

export function getOpenTables() {
  return [...openRooms].map((openRoom) => {
    const status = openRoom.game
      ? openRoom.game.phase === "over"
        ? "over"
        : "playing"
      : "lobby";
    // Name follows the current host seat so a handoff keeps the label honest.
    const hostSeat = openRoom.seats.find((s) => s.id === openRoom.host) ?? openRoom.seats[0];
    // Count every seat (bots included): sitDown refuses when length >= 4.
    const seated = openRoom.seats.length;
    return {
      code: openRoom.code,
      name: `${hostSeat?.name ?? "Host"}'s table`,
      seated,
      total: 4,
      status,
    };
  });
}
