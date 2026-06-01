// Town marketplace interface (req §18). An HTML overlay, like the HUD, that
// opens when a player unit reaches the town tile and lets the player:
//   - move resources freely between the unit's inventory and town storage,
//   - assemble a shopping cart of goods (and a horse) to buy, and
//   - offer goods from the inventory and/or town storage to pay for the cart.
// The shopkeeper accepts only when the offered value meets or beats the cart
// value (the surplus comes back as change in town storage).
//
// Read-only with respect to simulation state: every change is emitted as a
// `townStore` / `townTrade` / `moveUnits` Command and applied by update(). This
// module only holds transient view state — the cart and the pending offer.

import { HORSE_COST_VALUE } from "../config/index.js";
import { evaluateTownTrade, hasFreeStable, isUnitAtTown } from "../game/actions.js";
import type { Command } from "../game/commands.js";
import { HAMLET_CENTER } from "../game/map.js";
import {
  carriedTotal,
  RESOURCE_TYPES,
  RESOURCE_VALUE,
  type Inventory,
  type ResourceType,
} from "../game/resources.js";
import type { GameState } from "../game/state.js";
import { carryCap, hasHorse, type Unit } from "../game/units.js";

export interface TownPanel {
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

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function createTownPanel(opts: {
  container: HTMLElement;
  getState: () => GameState;
  enqueue: (cmd: Command) => void;
}): TownPanel {
  const { container, getState, enqueue } = opts;

  // Transient view state, all keyed to the unit currently shown (`activeId`).
  let activeId: number | null = null;
  let cart: Inventory = {};
  let cartHorse = false;
  let offerUnit: Inventory = {};
  let offerStorage: Inventory = {};
  // Units the player explicitly closed the dialog on; suppressed until they
  // leave town and come back. Cleared when the unit is no longer idle at town.
  const dismissed = new Set<number>();
  let lastSig = "";

  function resetSelections(): void {
    cart = {};
    cartHorse = false;
    offerUnit = {};
    offerStorage = {};
  }

  // The unit (if any) whose marketplace we should be showing: the first idle
  // player unit standing at the town tile that hasn't been dismissed.
  function activeUnit(state: GameState): Unit | null {
    const atTown: Unit[] = [];
    for (const u of Object.values(state.units)) {
      if (u.order.type === "idle" && u.insideBuildingId === null && isUnitAtTown(u, state.town)) {
        atTown.push(u);
      }
    }
    // Drop dismissals for units that have left town so they reopen on return.
    const present = new Set(atTown.map((u) => u.id));
    for (const id of [...dismissed]) if (!present.has(id)) dismissed.delete(id);

    atTown.sort((a, b) => a.id - b.id);
    return atTown.find((u) => !dismissed.has(u.id)) ?? null;
  }

  function btn(
    label: string,
    onClick: (e: MouseEvent) => void,
    opt: { disabled?: boolean; title?: string } = {},
  ): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (opt.title) b.title = opt.title;
    if (opt.disabled) {
      b.classList.add("disabled");
      b.setAttribute("aria-disabled", "true");
    } else {
      b.addEventListener("click", onClick);
    }
    return b;
  }

  function column(title: string): { col: HTMLElement; body: HTMLElement } {
    const col = document.createElement("div");
    col.className = "town-col";
    const h = document.createElement("div");
    h.className = "town-col-title";
    h.textContent = title;
    const body = document.createElement("div");
    body.className = "town-col-body";
    col.append(h, body);
    return { col, body };
  }

  function row(label: string): HTMLElement {
    const r = document.createElement("div");
    r.className = "town-row";
    const name = document.createElement("span");
    name.className = "town-row-name";
    name.textContent = label;
    r.append(name);
    return r;
  }

  // Render everything from current state + selections. Called whenever the
  // signature below changes (covers state updates landing a tick later).
  function rebuild(state: GameState, unit: Unit): void {
    container.innerHTML = "";
    const storage = state.townStorage;
    const load = carriedTotal(unit.carrying);
    const room = Math.max(0, carryCap(unit) - load);

    // Header --------------------------------------------------------------
    const header = document.createElement("div");
    header.className = "town-header";
    const title = document.createElement("span");
    title.className = "town-title";
    title.textContent = `Town Marketplace — ${cap(unit.kind)} #${unit.id}`;
    const headerBtns = document.createElement("span");
    headerBtns.className = "town-header-btns";
    headerBtns.append(
      btn("Send Home", () => {
        enqueue({ type: "moveUnits", unitIds: [unit.id], tx: HAMLET_CENTER.x, ty: HAMLET_CENTER.y });
        dismissed.add(unit.id);
      }, { title: "Walk back to the hamlet" }),
      btn("Close", () => { dismissed.add(unit.id); }, { title: "Leave the unit here, hide this panel" }),
    );
    header.append(title, headerBtns);

    const grid = document.createElement("div");
    grid.className = "town-grid";

    // For Sale ------------------------------------------------------------
    const sale = column("For Sale");
    for (const t of RESOURCE_TYPES) {
      const r = row(`${RESOURCE_LABEL[t]}`);
      const val = document.createElement("span");
      val.className = "town-val";
      val.textContent = `v${RESOURCE_VALUE[t]}`;
      r.append(val, btn("+", () => { cart[t] = (cart[t] ?? 0) + 1; }, { title: "Add one to cart" }));
      sale.body.append(r);
    }
    const freeStable = hasFreeStable(state.units, state.fields);
    {
      const r = row("Horse 🐴");
      const val = document.createElement("span");
      val.className = "town-val";
      val.textContent = `v${HORSE_COST_VALUE}`;
      const mounted = hasHorse(unit);
      r.append(
        val,
        btn("+", () => { cartHorse = true; }, {
          disabled: mounted || cartHorse || !freeStable,
          title: mounted
            ? "Already mounted"
            : !freeStable
              ? "No free stable — build/grow a hay field first (§9)"
              : "Add a horse to cart",
        }),
      );
      sale.body.append(r);
    }

    // Cart ----------------------------------------------------------------
    const cartCol = column("Cart");
    let anyCart = false;
    for (const t of RESOURCE_TYPES) {
      const n = cart[t] ?? 0;
      if (n <= 0) continue;
      anyCart = true;
      const r = row(`${n} ${RESOURCE_LABEL[t]}`);
      const val = document.createElement("span");
      val.className = "town-val";
      val.textContent = `(${n * RESOURCE_VALUE[t]})`;
      r.append(
        val,
        btn("−", () => { cart[t] = Math.max(0, (cart[t] ?? 0) - 1); }, { title: "Remove one" }),
      );
      cartCol.body.append(r);
    }
    if (cartHorse) {
      anyCart = true;
      const r = row("Horse 🐴");
      const val = document.createElement("span");
      val.className = "town-val";
      val.textContent = `(${HORSE_COST_VALUE})`;
      r.append(val, btn("−", () => { cartHorse = false; }, { title: "Remove" }));
      cartCol.body.append(r);
    }
    if (!anyCart) {
      const empty = document.createElement("div");
      empty.className = "town-empty";
      empty.textContent = "Empty — add goods from For Sale.";
      cartCol.body.append(empty);
    }

    // Town Storage --------------------------------------------------------
    const storeCol = column("Town Storage");
    let anyStore = false;
    for (const t of RESOURCE_TYPES) {
      const have = storage[t];
      const offered = offerStorage[t] ?? 0;
      if (have <= 0 && offered <= 0) continue;
      anyStore = true;
      const r = row(`${have} ${RESOURCE_LABEL[t]}`);
      r.append(
        btn("Take", (e) => takeFromStorage(t, e.shiftKey, room), {
          disabled: have <= 0 || room <= 0,
          title: room <= 0 ? "Carry full" : "Take (shift: all that fits)",
        }),
        offerStepper(offerStorage, t, have),
      );
      storeCol.body.append(r);
    }
    if (!anyStore) {
      const empty = document.createElement("div");
      empty.className = "town-empty";
      empty.textContent = "Nothing stored. Use Store to stash goods here (free, no cap).";
      storeCol.body.append(empty);
    }

    // Unit Inventory ------------------------------------------------------
    const invCol = column(`Carrying ${load}/${carryCap(unit)}`);
    let anyInv = false;
    for (const t of RESOURCE_TYPES) {
      const have = unit.carrying[t] ?? 0;
      if (have <= 0) continue;
      anyInv = true;
      const r = row(`${have} ${RESOURCE_LABEL[t]}`);
      r.append(
        btn("Store", (e) => storeToTown(t, e.shiftKey), {
          title: "Store at town (shift: all)",
        }),
        offerStepper(offerUnit, t, have),
      );
      invCol.body.append(r);
    }
    if (!anyInv) {
      const empty = document.createElement("div");
      empty.className = "town-empty";
      empty.textContent = "Carrying nothing.";
      invCol.body.append(empty);
    }

    grid.append(sale.col, cartCol.col, storeCol.col, invCol.col);

    // Offer / Confirm -----------------------------------------------------
    const ev = evaluateTownTrade(unit, storage, cart, cartHorse, offerUnit, offerStorage, freeStable);
    const footer = document.createElement("div");
    footer.className = "town-footer";
    const summary = document.createElement("span");
    summary.className = "town-summary";
    summary.textContent = `Offer ${ev.offerValue} / Need ${ev.cartValue}`;
    const status = document.createElement("span");
    status.className = "town-status";
    if (!ev.ok && ev.reason) status.textContent = ev.reason;
    else if (ev.ok) {
      const parts = RESOURCE_TYPES
        .filter((t) => (ev.change[t] ?? 0) > 0)
        .map((t) => `${ev.change[t]} ${t}`);
      if (parts.length > 0) status.textContent = `Change to storage: ${parts.join(", ")}`;
    }
    const confirm = btn("Confirm Trade", () => {
      enqueue({
        type: "townTrade",
        unitId: unit.id,
        cart: { ...cart },
        buyHorse: cartHorse,
        offerUnit: { ...offerUnit },
        offerStorage: { ...offerStorage },
      });
      resetSelections();
    }, { disabled: !ev.ok });
    confirm.classList.add("town-confirm");
    footer.append(summary, status, confirm);

    container.append(header, grid, footer);
  }

  // Offer stepper: −  n  + bounded by `available`. Mutates the given offer map.
  function offerStepper(into: Inventory, t: ResourceType, available: number): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "town-offer-stepper";
    const n = Math.min(into[t] ?? 0, available);
    into[t] = n; // clamp persisted value to what's still on hand
    const label = document.createElement("span");
    label.className = "town-offer-count";
    label.textContent = `offer ${n}`;
    wrap.append(
      btn("−", () => { into[t] = Math.max(0, (into[t] ?? 0) - 1); }, { disabled: n <= 0, title: "Offer one less" }),
      label,
      btn("+", () => { into[t] = Math.min(available, (into[t] ?? 0) + 1); }, { disabled: n >= available, title: "Offer one more" }),
    );
    return wrap;
  }

  function takeFromStorage(t: ResourceType, all: boolean, room: number): void {
    const have = getState().townStorage[t];
    const amount = all ? Math.min(have, room) : 1;
    if (amount <= 0) return;
    enqueue({ type: "townStore", unitId: activeId!, resource: t, amount, toStorage: false });
  }

  function storeToTown(t: ResourceType, all: boolean): void {
    const u = getState().units[activeId!];
    const have = u?.carrying[t] ?? 0;
    const amount = all ? have : 1;
    if (amount <= 0) return;
    enqueue({ type: "townStore", unitId: activeId!, resource: t, amount, toStorage: true });
  }

  // Signature of everything the rendered DOM depends on, so we rebuild only on
  // change (state mutations land a tick after a command, so polling is fine).
  function signature(state: GameState, unit: Unit): string {
    return JSON.stringify([
      unit.id,
      unit.carrying,
      unit.horseHp,
      state.townStorage,
      cart,
      cartHorse,
      offerUnit,
      offerStorage,
    ]);
  }

  function update(state: GameState): void {
    const unit = activeUnit(state);
    if (!unit) {
      if (!container.hidden) {
        container.hidden = true;
        container.innerHTML = "";
      }
      activeId = null;
      lastSig = "";
      return;
    }
    if (unit.id !== activeId) {
      activeId = unit.id;
      resetSelections();
      lastSig = "";
    }
    const sig = signature(state, unit);
    if (sig !== lastSig) {
      rebuild(state, unit);
      lastSig = sig;
    }
    container.hidden = false;
  }

  return { update };
}
