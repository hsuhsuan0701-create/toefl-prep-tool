import { describe, expect, it, vi } from "vitest";
import { deferred } from "./helpers/deferred.js";
import type { ProviderResult } from "../src/services/reasoning/contracts.js";
import {
  createProviderExecutor,
  type AdmissionController,
} from "../src/services/reasoning/providerExecutor.js";

function immediateAdmission(): AdmissionController {
  return {
    admit: async (_request, operation) => operation(),
  };
}

describe("ProviderExecutor", () => {
  it.each(["user", "shutdown", "superseded"] as const)("infers %s from an aborted signal when no explicit callback is supplied", async (reason) => {
    const controller = new AbortController();
    controller.abort(Object.assign(new Error("cancelled"), { reason }));
    const result = await createProviderExecutor({ admission: immediateAdmission() }).execute({
      provider: "claude", family: "scoring", operation: "aggregate", budgetMs: 10_000,
      jobId: "job", context: "email", signal: controller.signal, adapter: vi.fn(),
    });
    expect(result).toMatchObject({ status: "cancelled", reason });
  });

  it("normalizes scheduler AbortError as a separate cancellation envelope", async () => {
    const controller = new AbortController();
    const executor = createProviderExecutor({
      id: () => "queued-cancel",
      admission: {
        async admit() {
          controller.abort("user");
          throw new DOMException("aborted", "AbortError");
        },
      },
    });
    await expect(executor.execute({
      provider: "claude",
      family: "generation",
      operation: "generate",
      budgetMs: 10_000,
      jobId: "queued-job",
      context: "reading",
      signal: controller.signal,
      cancellationReason: () => "user",
      adapter: vi.fn(),
    })).resolves.toMatchObject({ status: "cancelled", reason: "user" });
  });

  it("starts the provider deadline only after admission", async () => {
    let nowMs = 1_000;
    const admitted = deferred<void>();
    let receivedExpiresAtMs = -1;
    const executor = createProviderExecutor({
      now: () => nowMs,
      // The stamps' clock, here the same fake one, so the stamps show when admission happened.
      epochNow: () => nowMs,
      id: () => "execution-1",
      admission: {
        async admit(_request, operation) {
          await admitted.promise;
          return operation();
        },
      },
    });

    const executing = executor.execute({
      provider: "claude",
      family: "scoring",
      operation: "aggregate",
      budgetMs: 750_000,
      jobId: "score-job-1",
      context: "email:item-1",
      adapter: async ({ deadline }) => {
        receivedExpiresAtMs = deadline.expiresAtMs;
        return { ok: true, provider: "claude", value: "ok" };
      },
    });

    nowMs = 51_000;
    admitted.resolve();
    await expect(executing).resolves.toMatchObject({
      status: "success",
      executionId: "execution-1",
      queuedAtMs: 1_000,
      dequeuedAtMs: 51_000,
    });
    expect(receivedExpiresAtMs).toBe(801_000);
  });

  it("returns cancellation separately and never invokes a pre-cancelled adapter", async () => {
    const controller = new AbortController();
    controller.abort("superseded");
    const adapter = vi.fn<() => Promise<ProviderResult<string, "codex">>>();
    const executor = createProviderExecutor({
      admission: immediateAdmission(),
      id: () => "execution-2",
    });

    const result = await executor.execute({
      provider: "codex",
      family: "generation",
      operation: "generate",
      budgetMs: 900_000,
      jobId: "generation-child-2",
      context: "reading",
      signal: controller.signal,
      cancellationReason: () => "superseded",
      adapter,
    });

    expect(result).toMatchObject({
      status: "cancelled",
      reason: "superseded",
      provider: "codex",
    });
    expect(adapter).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("failure");
  });

  it("isolates lifecycle observers from execution", async () => {
    const observed: string[] = [];
    const executor = createProviderExecutor({
      admission: immediateAdmission(),
      id: () => "execution-3",
    });

    const result = await executor.execute({
      provider: "claude",
      family: "scoring",
      operation: "aggregate",
      budgetMs: 10_000,
      jobId: "job-3",
      context: "discussion",
      observer(event) {
        observed.push(event.state);
        if (event.state === "dequeued") throw new Error("observer failure");
        if (event.state === "finished") {
          return Promise.reject(new Error("async observer failure"));
        }
      },
      adapter: async () => ({
        ok: true,
        provider: "claude",
        value: "safe",
      }),
    });

    expect(result).toMatchObject({ status: "success", value: "safe" });
    expect(observed).toEqual(["queued", "dequeued", "started", "finished"]);
  });

  it("short-circuits an open circuit after dequeue and reports the terminal policy outcome", async () => {
    const adapter = vi.fn();
    const terminals: unknown[] = [];
    const executor = createProviderExecutor({
      admission: immediateAdmission(),
      id: () => "execution-4",
    });

    const result = await executor.execute({
      provider: "claude",
      family: "generation",
      operation: "verify",
      budgetMs: 750_000,
      jobId: "generation-child-4",
      context: "listening",
      beforeStart: () => ({
        ok: false,
        failure: {
          provider: "claude",
          kind: "quota",
          source: "circuit",
        },
      }),
      onTerminal: (terminal) => terminals.push(terminal),
      adapter,
    });

    expect(result).toMatchObject({
      status: "failure",
      failure: {
        provider: "claude",
        kind: "quota",
        source: "circuit",
      },
    });
    expect(adapter).not.toHaveBeenCalled();
    expect(terminals).toEqual([
      {
        ok: false,
        failure: {
          provider: "claude",
          kind: "quota",
          source: "circuit",
        },
      },
    ]);
  });

  it("rejects new work from an open circuit before entering admission", async () => {
    const admission = vi.fn();
    const executor = createProviderExecutor({
      admission: { admit: admission },
      id: () => "execution-open",
    });
    const result = await executor.execute({
      provider: "codex",
      family: "scoring",
      operation: "aggregate",
      budgetMs: 300_000,
      jobId: "job-open",
      context: "email",
      beforeAdmission: () => ({
        ok: false,
        failure: { provider: "codex", kind: "quota", source: "circuit" },
      }),
      adapter: vi.fn(),
    });
    expect(result).toMatchObject({ status: "failure", failure: { kind: "quota", source: "circuit" } });
    expect(admission).not.toHaveBeenCalled();
  });
});
