// Wire shapes of the client-controller mod HTTP contract (docs/client-controller.md §4).
// These are the *only* shapes this adapter knows; upper layers see contracts, not these.

/** Response of POST /action. Control ops carry a receipt; read ops carry `result`. */
export interface WireAction {
  ok: boolean;
  accepted?: boolean;
  level?: string;
  note?: string;
  result?: unknown;
  error?: string;
}

export interface WireHealth {
  ok: boolean;
  mc: string;
  mod_version: string;
  in_world: boolean;
  player: string;
  dimension: string;
  screen: string;
  port: number;
}
