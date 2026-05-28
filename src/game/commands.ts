// Commands are the only way input influences the simulation (req §2.6). The
// input layer produces Commands; update() consumes them. More order types
// (gather/build/etc., req §6.5) will be added here in later milestones.
//
// Note: pause is a game-loop concern, not a Command — it stops update() from
// being called at all rather than mutating simulation state.

export type Command = {
  type: "moveUnits";
  unitIds: number[];
  tx: number;
  ty: number;
};
