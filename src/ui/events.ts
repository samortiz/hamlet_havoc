// Year-end event modal + game-over screen (req §16.4, §21). A full-screen
// overlay shown while the game phase is `endOfYearEvent` (the modal interruption
// that names the event and gathers any required player choice) or `gameOver`
// (run stats + restart). Read-only with respect to the simulation: every action
// is emitted as a Command (`payTax` / `acknowledgeEvent`) or the `onRestart`
// callback; this module only holds transient view state (the pending tax offer).

import {
  barracksHousingCap,
  buildingTaxValue,
  resourceTaxGold,
  resourceTaxRate,
  workerHousingCap,
} from "../game/actions.js";
import {
  storageCapacity,
  type Building,
  type BuildingKind,
} from "../game/buildings.js";
import type { Command } from "../game/commands.js";
import {
  MISC_LABEL,
  MISC_TRADE_OFFERS,
  type MiscTradeOffer,
  TAX_LABEL,
} from "../game/events.js";
import {
  poolTotal,
  RESOURCE_TYPES,
  type Inventory,
  type ResourceType,
} from "../game/resources.js";
import { deriveSeason, type GameState } from "../game/state.js";

export interface EventOverlay {
  update: (state: GameState) => void;
}

const RESOURCE_LABEL: Record<ResourceType, string> = {
  wheat: "Wheat",
  wood: "Wood",
  stone: "Stone",
  meat: "Meat",
  iron: "Iron",
  gold: "Gold",
  diamond: "Diamond",
};

const BUILDING_LABEL: Record<BuildingKind, string> = {
  mainHall: "Main Hall",
  house: "House",
  barn: "Barn",
  smithy: "Smithy",
  barracks: "Barracks",
  mine: "Mine",
};

export function createEventOverlay(opts: {
  overlay: HTMLElement; // #event-overlay
  dialog: HTMLElement; // #event-dialog
  enqueue: (cmd: Command) => void;
  onRestart: () => void;
}): EventOverlay {
  const { overlay, dialog, enqueue, onRestart } = opts;

  // Transient tax-surrender selections, reset when the tax modal opens/closes.
  let taxOffer: Inventory = {};
  let taxBuildings = new Set<number>();
  let taxInit = false;
  let lastSig = "";

  function btn(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (disabled) {
      b.classList.add("disabled");
      b.setAttribute("aria-disabled", "true");
    } else {
      b.addEventListener("click", onClick);
    }
    return b;
  }

  function header(title: string): HTMLElement {
    const h = document.createElement("div");
    h.className = "event-title";
    h.textContent = title;
    return h;
  }

  function paragraph(text: string, cls = "event-body"): HTMLElement {
    const p = document.createElement("div");
    p.className = cls;
    p.textContent = text;
    return p;
  }

  // Gold amounts may be fractional (§16.2.1); show up to 2 decimals, no trailing
  // zeros (e.g. 1.5, 0.15, 10).
  function fmtGold(n: number): string {
    return String(Math.round(n * 100) / 100);
  }

  // --- Tax surrender contribution (mirrors actions.evaluateTax for the UI) ---
  function taxContribution(state: GameState): number {
    let buildingValue = 0;
    for (const id of taxBuildings) {
      const b = state.buildings[id];
      if (b) buildingValue += buildingTaxValue(b.kind);
    }
    return resourceTaxGold(taxOffer) + buildingValue;
  }

  // Can the player take `offer` right now (§16.3, item 32)? Mirrors the sim's
  // applyMiscTrade gates so the modal disables the rest: per-offer cap, pool
  // affordability, storage room for a bought resource, housing for a recruit.
  function offerEnabled(
    state: GameState,
    offer: MiscTradeOffer,
    purchases: Record<string, number>,
  ): boolean {
    if (offer.max !== undefined && (purchases[offer.id] ?? 0) >= offer.max) return false;
    for (const t of RESOURCE_TYPES) {
      if (state.resources[t] < (offer.cost[t] ?? 0)) return false;
    }
    if (offer.gainResources) {
      let costTotal = 0;
      let gainTotal = 0;
      for (const t of RESOURCE_TYPES) {
        costTotal += offer.cost[t] ?? 0;
        gainTotal += offer.gainResources[t] ?? 0;
      }
      if (poolTotal(state.resources) - costTotal + gainTotal > storageCapacity(state.buildings)) {
        return false;
      }
    }
    if (offer.gainUnit) {
      const units = Object.values(state.units);
      if (offer.gainUnit === "worker") {
        if (units.filter((u) => u.kind === "worker").length >= workerHousingCap(state.buildings)) {
          return false;
        }
      } else {
        const military = units.filter((u) => u.kind === "soldier" || u.kind === "captain").length;
        if (military >= barracksHousingCap(state.buildings)) return false;
      }
    }
    return true;
  }

  function renderMisc(state: GameState): void {
    const ev = state.activeEvent;
    if (ev?.category !== "misc") return;
    dialog.append(header(MISC_LABEL[ev.misc]));
    dialog.append(paragraph(ev.summary));

    // Trade-dialog events (§16.3, item 32): list the fixed offers as buttons,
    // disabled when capped/unaffordable/no room; closing the dialog ends trading.
    if (ev.trade) {
      const stock = paragraph(
        "On hand: " +
          RESOURCE_TYPES.filter((t) => state.resources[t] > 0)
            .map((t) => `${state.resources[t]} ${RESOURCE_LABEL[t].toLowerCase()}`)
            .join(", "),
        "event-hint",
      );
      dialog.append(stock);

      const offers = document.createElement("div");
      offers.className = "event-offers";
      for (const offer of MISC_TRADE_OFFERS[ev.trade.kind]) {
        const bought = ev.trade.purchases[offer.id] ?? 0;
        const capSuffix = offer.max !== undefined ? ` (${bought}/${offer.max})` : "";
        offers.append(
          btn(
            `${offer.label}${capSuffix}`,
            () => enqueue({ type: "miscTrade", offerId: offer.id }),
            !offerEnabled(state, offer, ev.trade.purchases),
          ),
        );
      }
      dialog.append(offers);

      const footer = document.createElement("div");
      footer.className = "event-footer";
      footer.append(btn("Done", () => enqueue({ type: "acknowledgeEvent" })));
      dialog.append(footer);
      return;
    }

    const footer = document.createElement("div");
    footer.className = "event-footer";
    footer.append(btn("OK", () => enqueue({ type: "acknowledgeEvent" })));
    dialog.append(footer);
  }

  function renderTax(state: GameState): void {
    const ev = state.activeEvent;
    if (ev?.category !== "tax") return;
    // Name the tax flavour so the player can see how the demand was derived (§16.2.1).
    dialog.append(header(`💰 ${TAX_LABEL[ev.flavour]}`));
    dialog.append(paragraph(`The collector demands ${ev.demand} gold.`));
    dialog.append(
      paragraph(
        "Choose what to surrender. Gold pays face value, diamonds pay double, " +
          "every other good pays half its value. No change is given for an overpayment.",
        "event-hint",
      ),
    );

    // Resource surrender steppers (only resources the hamlet actually holds). Gold
    // and diamonds appear here too, so the player chooses how to pay (§16.2.1).
    const goods = document.createElement("div");
    goods.className = "event-goods";
    for (const t of RESOURCE_TYPES) {
      const have = state.resources[t];
      if (have <= 0) continue;
      const n = Math.min(taxOffer[t] ?? 0, have);
      taxOffer[t] = n;
      const row = document.createElement("div");
      row.className = "event-row";
      const name = document.createElement("span");
      name.textContent = `${RESOURCE_LABEL[t]} (${have}) · ${fmtGold(resourceTaxRate(t))}g each`;
      row.append(
        name,
        btn("−", () => { taxOffer[t] = Math.max(0, (taxOffer[t] ?? 0) - 1); }, n <= 0),
        Object.assign(document.createElement("span"), { className: "event-offer", textContent: `${n}` }),
        btn("+", () => { taxOffer[t] = Math.min(have, (taxOffer[t] ?? 0) + 1); }, n >= have),
      );
      goods.append(row);
    }
    dialog.append(goods);

    // Building surrender toggles (every building except the Main Hall).
    const buildings = document.createElement("div");
    buildings.className = "event-buildings";
    for (const b of Object.values(state.buildings) as Building[]) {
      if (b.kind === "mainHall") continue;
      const on = taxBuildings.has(b.id);
      const label = `${BUILDING_LABEL[b.kind]} #${b.id} (worth ${fmtGold(buildingTaxValue(b.kind))}g)`;
      const t = btn(`${on ? "✓ " : ""}${label}`, () => {
        if (taxBuildings.has(b.id)) taxBuildings.delete(b.id);
        else taxBuildings.add(b.id);
      });
      if (on) t.classList.add("event-selected");
      buildings.append(t);
    }
    dialog.append(buildings);

    const contribution = taxContribution(state);
    const status = paragraph(
      `Paying ${fmtGold(contribution)} of ${ev.demand} gold.`,
      "event-status",
    );
    dialog.append(status);

    const footer = document.createElement("div");
    footer.className = "event-footer";
    footer.append(
      btn(
        "Pay",
        () =>
          enqueue({
            type: "payTax",
            offerResources: { ...taxOffer },
            surrenderBuildingIds: [...taxBuildings],
            forfeit: false,
          }),
        contribution + 1e-9 < ev.demand,
      ),
      btn(
        "Forfeit (surrender all offered, forgive rest)",
        () =>
          enqueue({
            type: "payTax",
            offerResources: { ...taxOffer },
            surrenderBuildingIds: [...taxBuildings],
            forfeit: true,
          }),
      ),
    );
    dialog.append(footer);
  }

  function renderGameOver(state: GameState): void {
    dialog.append(header("☠️ Game Over"));
    const { year } = deriveSeason(state.tickCount);
    const hasHall = Object.values(state.buildings).some((b) => b.kind === "mainHall");
    dialog.append(paragraph(hasHall ? "The hamlet ran out of workers." : "The Main Hall was destroyed."));
    dialog.append(
      paragraph(
        `Years survived: ${state.stats.yearsSurvived} · Reached: Year ${year} · Peak population: ${state.stats.peakPopulation}`,
        "event-status",
      ),
    );
    const footer = document.createElement("div");
    footer.className = "event-footer";
    footer.append(btn("New Game", onRestart));
    dialog.append(footer);
  }

  // Signature of everything the DOM depends on, so we rebuild only on change.
  function signature(state: GameState): string {
    return JSON.stringify([
      state.phase,
      state.activeEvent,
      Object.keys(state.enemies).length,
      state.stats,
      taxOffer,
      [...taxBuildings],
      // Resource snapshot so the tax steppers reflect surrenders landing.
      state.phase === "endOfYearEvent" ? state.resources : 0,
    ]);
  }

  function update(state: GameState): void {
    if (state.phase === "playing") {
      if (!overlay.hidden) {
        overlay.hidden = true;
        dialog.replaceChildren();
      }
      taxInit = false;
      lastSig = "";
      return;
    }

    // Reset the tax picker once per event entry.
    if (!taxInit) {
      taxOffer = {};
      taxBuildings = new Set();
      taxInit = true;
      lastSig = "";
    }

    // Tax/Misc/game-over are true modals that capture clicks. (Attacks no longer
    // open this overlay — they are fought live with only a HUD warning, §16.1.)
    const sig = signature(state);
    if (sig !== lastSig) {
      dialog.replaceChildren();
      if (state.phase === "gameOver") {
        renderGameOver(state);
      } else if (state.activeEvent?.category === "tax") {
        renderTax(state);
      } else if (state.activeEvent?.category === "misc") {
        renderMisc(state);
      }
      lastSig = sig;
    }
    overlay.hidden = false;
  }

  return { update };
}
