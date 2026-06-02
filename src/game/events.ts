// End-of-year events (req §16). This module holds the *pure data model* for the
// year-end event system — the announced upcoming event, the resolving active
// event, and the seeded selection of next year's event. The event *logic*
// (spawning attack waves, applying tax/misc effects) lives in actions.ts, which
// owns the mutable SimCtx; keeping the types here avoids an import cycle.
//
// Exactly one event fires per year at the winter→spring boundary (§16.0). Only
// the *type* is revealed a year ahead (the HUD's Upcoming Event slot, §16.4);
// the magnitude is rolled when the event triggers.

import type { CraftItem } from "./buildings.js";
import { RESOURCE_VALUE, type Inventory, type ResourceType } from "./resources.js";
import { rngNext } from "./rng.js";
import type { UnitKind } from "./units.js";

export type EventCategory = "attack" | "tax" | "misc";

// The misc library (§16.3). The full table from the req doc; split into good/bad
// only so the HUD can pick an icon and so year 1 can draw specifically from the
// good half (§16.0). The per-year Misc selection itself is uniform across the
// whole list (§16.3) — good outnumbers bad by construction, to offset the
// always-bad attack/tax years. Four of the good events (Mercenaries, Forest
// Alchemist, Migrants, Trader) open a trade dialog instead of applying a fixed
// effect (item 32 / MiscTradeKind below).
export type MiscEventKind =
  | "bountifulHarvest"
  | "cropBlight"
  | "plague"
  | "festival"
  | "mildWinter"
  | "harshWinter"
  | "storageThief"
  | "lostCaravan"
  | "mercenaries"
  | "barnFire"
  | "forestAlchemist"
  | "termites"
  | "woodBoon"
  | "midasTouch"
  | "neighbors"
  | "migrants"
  | "migrantLaborers"
  | "trader"
  | "blight";

export const MISC_GOOD: readonly MiscEventKind[] = [
  "bountifulHarvest",
  "festival",
  "mildWinter",
  "lostCaravan",
  "mercenaries",
  "forestAlchemist",
  "woodBoon",
  "midasTouch",
  "neighbors",
  "migrants",
  "migrantLaborers",
  "trader",
];
export const MISC_BAD: readonly MiscEventKind[] = [
  "cropBlight",
  "plague",
  "harshWinter",
  "storageThief",
  "barnFire",
  "termites",
  "blight",
];
// The full library a normal Misc year draws from, uniformly (§16.3). Good
// outnumbers bad by construction, to offset the always-bad attack/tax years.
export const MISC_ALL: readonly MiscEventKind[] = [...MISC_GOOD, ...MISC_BAD];

// --- Misc trade events (§16.3, item 32) ------------------------------------
// Four Misc events open a trade dialog rather than applying a fixed effect: the
// player executes the event's fixed offers repeatedly (deterministic, no RNG)
// until the dialog closes. Offers are declarative data so the UI can render and
// gate them and actions.ts can apply them from one source of truth.
export type MiscTradeKind = "mercenaries" | "forestAlchemist" | "migrants" | "trader";

// Is this misc event a trade dialog? (Narrows MiscEventKind → MiscTradeKind.)
export function miscTradeKind(misc: MiscEventKind): MiscTradeKind | null {
  return misc === "mercenaries" || misc === "forestAlchemist" || misc === "migrants" || misc === "trader"
    ? misc
    : null;
}

// One fixed offer in a trade dialog. `cost` is paid from the hamlet pool; the
// yield is exactly one of: resources into the pool (capped at storage), a unit
// (housing-gated), or a crafted item into the equipment pool. `max` caps how
// many times this offer can be taken for the event (omitted = unlimited).
export interface MiscTradeOffer {
  id: string;
  label: string;
  cost: Inventory;
  gainResources?: Inventory;
  gainUnit?: UnitKind;
  gainEquipment?: CraftItem;
  max?: number;
}

// Trader (§16.3) reuses the town economy: every resource (except the gold
// currency itself) can be bought or sold for gold at its listed value, with no
// unit or town trip. Generated from the value table so it stays in sync.
const TRADER_OFFERS: MiscTradeOffer[] = (
  ["wheat", "wood", "stone", "meat", "iron", "diamond"] as ResourceType[]
).flatMap((t): MiscTradeOffer[] => [
  { id: `sell-${t}`, label: `Sell 1 ${t} → ${RESOURCE_VALUE[t]} gold`, cost: { [t]: 1 }, gainResources: { gold: RESOURCE_VALUE[t] } },
  { id: `buy-${t}`, label: `${RESOURCE_VALUE[t]} gold → 1 ${t}`, cost: { gold: RESOURCE_VALUE[t] }, gainResources: { [t]: 1 } },
]);

export const MISC_TRADE_OFFERS: Record<MiscTradeKind, MiscTradeOffer[]> = {
  // 3 gold → 1 captain (max 1); 1 gold → 1 soldier (max 3).
  mercenaries: [
    { id: "captain", label: "3 gold → 1 Captain", cost: { gold: 3 }, gainUnit: "captain", max: 1 },
    { id: "soldier", label: "1 gold → 1 Soldier", cost: { gold: 1 }, gainUnit: "soldier", max: 3 },
  ],
  // 2 wood→1 iron, 3 wood→1 gold, 3 wheat→1 meat, 6 wood→1 sword, 9 wood→1 shield.
  forestAlchemist: [
    { id: "iron", label: "2 wood → 1 Iron", cost: { wood: 2 }, gainResources: { iron: 1 } },
    { id: "gold", label: "3 wood → 1 Gold", cost: { wood: 3 }, gainResources: { gold: 1 } },
    { id: "meat", label: "3 wheat → 1 Meat", cost: { wheat: 3 }, gainResources: { meat: 1 } },
    { id: "sword", label: "6 wood → 1 Sword", cost: { wood: 6 }, gainEquipment: "sword" },
    { id: "shield", label: "9 wood → 1 Shield", cost: { wood: 9 }, gainEquipment: "shield" },
  ],
  // 1 meat → 1 worker; 1 gold → 1 soldier. Multiple, housing-gated.
  migrants: [
    { id: "worker", label: "1 meat → 1 Worker", cost: { meat: 1 }, gainUnit: "worker" },
    { id: "soldier", label: "1 gold → 1 Soldier", cost: { gold: 1 }, gainUnit: "soldier" },
  ],
  trader: TRADER_OFFERS,
};

// Per-event trade progress carried on the resolving ActiveEvent: how many of
// each offer the player has taken, used to enforce `max`.
export interface MiscTradeState {
  kind: MiscTradeKind;
  purchases: Record<string, number>;
}

// Attack flavours (§16.1). The flavour is rolled at *trigger* (not announced),
// so the player can't optimise against a single keyed stat. Each keys off a
// different hamlet stat: raiding party → workers, warband → buildings, plunder
// → stored value, goblinDragon → gold/diamonds (a dragon at 2+ diamonds, else a
// goblin horde).
export type AttackFlavour = "raidingParty" | "warband" | "plunder" | "goblinDragon";

// Banner phrase for an attack wave (§16.1, §19.1). The goblin/dragon flavour
// reads as "A dragon" or "A goblin horde" depending on what actually spawned.
export function attackFlavourLabel(flavour: AttackFlavour, hasDragon: boolean): string {
  switch (flavour) {
    case "raidingParty":
      return "A raiding party";
    case "warband":
      return "A warband";
    case "plunder":
      return "Plunderers";
    case "goblinDragon":
      return hasDragon ? "A dragon" : "A goblin horde";
  }
}

// Tax flavours (§16.2). Like the attack flavour, the flavour is rolled at
// *trigger*, and each keys the gold demand off a different hamlet stat plus the
// year so the player cannot dodge it by managing a single resource.
export type TaxFlavour =
  | "worker"
  | "weapon"
  | "building"
  | "housing"
  | "animal"
  | "wealth"
  | "resource";

// The pool a tax year draws from, uniformly (§16.2). Order is irrelevant; the
// per-year pick is a seeded index into this list.
export const TAX_FLAVOURS: readonly TaxFlavour[] = [
  "worker",
  "weapon",
  "building",
  "housing",
  "animal",
  "wealth",
  "resource",
];

export const TAX_LABEL: Record<TaxFlavour, string> = {
  worker: "Worker Tax",
  weapon: "Weapon Tax",
  building: "Building Tax",
  housing: "Housing Tax",
  animal: "Animal Tax",
  wealth: "Wealth Tax",
  resource: "Resource Tax",
};

// The announced upcoming event — only the type is known in advance (§16.0). For
// a Misc event the specific named event is revealed; for Attack only "Attack".
export type UpcomingEvent =
  | { category: "attack" }
  | { category: "tax" }
  | { category: "misc"; misc: MiscEventKind };

// The event currently resolving during the EndOfYearEvent (modal) phase (§21.1):
// only Tax and Misc are modal and carry an ActiveEvent. An Attack is fought live
// in the `playing` phase and never sets one (§16.1).
export type ActiveEvent =
  | { category: "tax"; flavour: TaxFlavour; demand: number }
  // `trade` is set only for the four trade-dialog Misc events (§16.3, item 32);
  // it tracks per-offer purchase counts while the dialog is open.
  | { category: "misc"; misc: MiscEventKind; summary: string; trade?: MiscTradeState };

// Human-readable label for the HUD announcement + event modal (§16.4, §19.1).
export const MISC_LABEL: Record<MiscEventKind, string> = {
  bountifulHarvest: "Bountiful Harvest",
  cropBlight: "Crop Blight",
  plague: "Plague",
  festival: "Festival",
  mildWinter: "Mild Winter",
  harshWinter: "Harsh Winter",
  storageThief: "Storage Thief",
  lostCaravan: "Lost Caravan",
  mercenaries: "Mercenaries",
  barnFire: "Barn Fire",
  forestAlchemist: "Forest Alchemist",
  termites: "Termites",
  woodBoon: "Wood Boon",
  midasTouch: "Midas Touch",
  neighbors: "Neighbors",
  migrants: "Migrants",
  migrantLaborers: "Migrant Laborers",
  trader: "Trader",
  blight: "Blight",
};

export function isMiscGood(kind: MiscEventKind): boolean {
  return MISC_GOOD.includes(kind);
}

export function upcomingLabel(ev: UpcomingEvent): string {
  if (ev.category === "attack") return "Attack";
  if (ev.category === "tax") return "Tax Collector";
  // Misc: only the type is revealed in advance (§16.0, §19.1). The specific
  // named event (and whether it's good or bad) stays hidden until it fires.
  return "Misc";
}

export function upcomingIcon(ev: UpcomingEvent): string {
  if (ev.category === "attack") return "⚔️";
  if (ev.category === "tax") return "💰";
  // Neutral icon — see upcomingLabel: the Misc kind is hidden until it fires.
  return "❓";
}

// The categories making up the rolling block that contains `year` (§16.0):
// years 2-3 are an Attack + a Tax; every later 3-year block (4-6, 7-9, …) is one
// each of Misc, Tax, Attack. (Year 1 is special-cased before this is consulted.)
function blockForYear(year: number): EventCategory[] {
  return year <= 3 ? ["attack", "tax"] : ["misc", "tax", "attack"];
}

// Seeded Fisher-Yates shuffle, so a block's order is deterministic per run.
function shuffle<T>(rngState: number, items: readonly T[]): [number, T[]] {
  let rng = rngState;
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    let v: number;
    [rng, v] = rngNext(rng);
    const j = Math.floor(v * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return [rng, out];
}

// Pick a Misc event uniformly from `pool` (§16.3). Used for both the year-1 good
// Misc (pool = MISC_GOOD) and a normal Misc year (pool = MISC_ALL).
function pickMisc(rngState: number, pool: readonly MiscEventKind[]): [number, MiscEventKind] {
  const [rng, p] = rngNext(rngState);
  return [rng, pool[Math.floor(p * pool.length)] ?? pool[0]];
}

// Choose the event for `year` along the fixed §16.0 cadence. `schedule` is the
// categories remaining in the current block (already shuffled); we pop one per
// year and reshuffle a fresh block when it empties. Seeded, so deterministic.
// Returns the leftover schedule to thread back into state.
export function chooseUpcomingEvent(
  rngState: number,
  year: number,
  schedule: readonly EventCategory[],
): [nextState: number, event: UpcomingEvent, schedule: EventCategory[]] {
  // Year 1 is always a gentle opener: a good Misc, drawn outside the schedule.
  if (year <= 1) {
    const [rng, misc] = pickMisc(rngState, MISC_GOOD);
    return [rng, { category: "misc", misc }, schedule.slice()];
  }

  let rng = rngState;
  let queue = schedule.slice();
  if (queue.length === 0) {
    [rng, queue] = shuffle(rng, blockForYear(year));
  }
  const category = queue.shift() ?? "misc";

  if (category === "attack") return [rng, { category: "attack" }, queue];
  if (category === "tax") return [rng, { category: "tax" }, queue];
  const [r, misc] = pickMisc(rng, MISC_ALL);
  return [r, { category: "misc", misc }, queue];
}
