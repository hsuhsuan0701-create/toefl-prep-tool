import { Hono } from "hono";
import type { ReasoningStatusVM } from "@toefl-prep/shared";

export function buildProviderRoutes(deps: {
  snapshot: () => ReasoningStatusVM;
}) {
  return new Hono().get("/", (c) => c.json(deps.snapshot()));
}
