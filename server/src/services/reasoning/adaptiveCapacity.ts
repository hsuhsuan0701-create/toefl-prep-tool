export type CapacityTerminal = "success" | "invalid-output" | "timeout" | "cancelled" | "pressure";

export interface AdaptiveCapacitySnapshot {
  readonly capacity: number;
  readonly floor: number;
  readonly ceiling: number;
  readonly cleanTerminals: number;
  readonly pressureStrikes: number;
}

export interface CapacityDecision {
  readonly capacity: number;
  readonly openCircuit: boolean;
}

/** How many recently struck rate-limit windows are remembered for deduplication. */
const REMEMBERED_WINDOWS = 256;

/** Additive-increase, pressure-sensitive provider capacity policy. */
export class AdaptiveCapacity {
  private capacity: number;
  private cleanTerminals = 0;
  private readonly pressureAt: number[] = [];
  private readonly struckWindows = new Set<string>();
  private readonly struckWindowOrder: string[] = [];
  private readonly now: () => number;
  private readonly pressureWindowMs: number;

  constructor(private readonly options: {
    readonly floor: number;
    readonly initial: number;
    readonly ceiling: number;
    readonly now?: () => number;
    readonly pressureWindowMs?: number;
  }) {
    if (
      ![options.floor, options.initial, options.ceiling].every(Number.isInteger) ||
      options.floor < 1 || options.floor > options.initial || options.initial > options.ceiling
    ) throw new RangeError("capacity requires 1 <= floor <= initial <= ceiling");
    this.capacity = options.initial;
    this.now = options.now ?? Date.now;
    this.pressureWindowMs = options.pressureWindowMs ?? 60_000;
  }

  recordTerminal(terminal: CapacityTerminal): CapacityDecision {
    if (terminal === "cancelled" || terminal === "invalid-output" || terminal === "timeout") {
      this.cleanTerminals = 0;
      return this.decision(false);
    }
    if (terminal === "success") {
      this.cleanTerminals += 1;
      if (this.cleanTerminals >= this.capacity && this.capacity < this.options.ceiling) {
        this.capacity += 1;
        this.cleanTerminals = 0;
      }
      return this.decision(false);
    }

    return this.decision(this.strike() >= 3);
  }

  /**
   * Pressure a served call reported about a rate-limit window. Every call made while a window runs
   * hot reports it, so only the first report of a window strikes; and since the call was served,
   * the strike only contracts capacity. It never opens the circuit, though it does count toward the
   * strikes a later failed call is judged against. Pressure with no window identity cannot be
   * deduplicated and always strikes.
   */
  recordWindowPressure(window?: string): CapacityDecision {
    if (window === undefined) {
      this.strike();
    } else if (!this.struckWindows.has(window)) {
      this.struckWindows.add(window);
      this.struckWindowOrder.push(window);
      if (this.struckWindowOrder.length > REMEMBERED_WINDOWS) {
        this.struckWindows.delete(this.struckWindowOrder.shift()!);
      }
      this.strike();
    }
    return this.decision(false);
  }

  /** First strike in the window drops one slot, a second halves, a third falls to the floor. */
  private strike(): number {
    const cutoff = this.now() - this.pressureWindowMs;
    while (this.pressureAt[0] !== undefined && this.pressureAt[0] < cutoff) this.pressureAt.shift();
    this.pressureAt.push(this.now());
    this.cleanTerminals = 0;
    if (this.pressureAt.length === 1) this.capacity = Math.max(this.options.floor, this.capacity - 1);
    else if (this.pressureAt.length === 2) this.capacity = Math.max(this.options.floor, Math.floor(this.capacity / 2));
    else this.capacity = this.options.floor;
    return this.pressureAt.length;
  }

  resetAfterCircuit(resumeCapacity = 2): CapacityDecision {
    this.capacity = Math.min(this.options.ceiling, Math.max(this.options.floor, resumeCapacity));
    this.cleanTerminals = 0;
    this.pressureAt.length = 0;
    return this.decision(false);
  }

  snapshot(): AdaptiveCapacitySnapshot {
    const cutoff = this.now() - this.pressureWindowMs;
    const pressureStrikes = this.pressureAt.filter((at) => at >= cutoff).length;
    return Object.freeze({
      capacity: this.capacity,
      floor: this.options.floor,
      ceiling: this.options.ceiling,
      cleanTerminals: this.cleanTerminals,
      pressureStrikes,
    });
  }

  private decision(openCircuit: boolean): CapacityDecision {
    return Object.freeze({ capacity: this.capacity, openCircuit });
  }
}
