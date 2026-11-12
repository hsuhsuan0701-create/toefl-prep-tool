const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type ShutdownProtocolInput = {
  stopAdmissions(): void;
  activeCount(): number;
  persistCancellation(): Promise<void> | void;
  abortRemaining(): void;
  flushRecorder(): Promise<void> | void;
  drainMs?: number;
  recorderFlushMs?: number;
  pollMs?: number;
};

export async function runShutdownProtocol(input: ShutdownProtocolInput): Promise<void> {
  const drainMs = input.drainMs ?? 30_000;
  const recorderFlushMs = input.recorderFlushMs ?? 5_000;
  const pollMs = input.pollMs ?? 50;
  input.stopAdmissions();

  const deadline = Date.now() + drainMs;
  while (input.activeCount() > 0 && Date.now() < deadline) {
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  if (input.activeCount() > 0) {
    await input.persistCancellation();
    input.abortRemaining();
  }
  await Promise.race([
    Promise.resolve(input.flushRecorder()),
    delay(recorderFlushMs),
  ]);
}
