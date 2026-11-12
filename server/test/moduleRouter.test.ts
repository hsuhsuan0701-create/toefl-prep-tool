import { describe, expect, it } from "vitest";
import { decidePath, ROUTER_PROMOTION_THRESHOLD } from "../src/services/moduleRouter.js";

describe("ROUTER_PROMOTION_THRESHOLD", () => {
  it("is the documented [ours] constant", () => {
    expect(ROUTER_PROMOTION_THRESHOLD).toBe(0.6);
  });
});

describe("decidePath", () => {
  it("promotes at exactly the threshold (>=)", () => {
    expect(decidePath(6, 10).path).toBe("upper"); // 0.6 exactly
    expect(decidePath(15, 26).path).toBe("lower"); // 0.577
    expect(decidePath(16, 26).path).toBe("upper"); // 0.615
  });

  it("returns the raw fraction alongside the path", () => {
    expect(decidePath(6, 10)).toEqual({ path: "upper", routerRaw: 0.6 });
    const below = decidePath(15, 26);
    expect(below.path).toBe("lower");
    expect(below.routerRaw).toBeCloseTo(15 / 26);
  });

  it("routes a perfect and a zero score to opposite paths", () => {
    expect(decidePath(10, 10).path).toBe("upper");
    expect(decidePath(0, 10).path).toBe("lower");
  });
});
