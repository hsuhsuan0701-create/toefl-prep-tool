/**
 * Compile-time exhaustiveness check for a discriminated union's final `else` or `default` arm. Call it
 * with the value TypeScript has narrowed to `never` once every case is handled: a member added to the
 * union later makes the call site fail to compile instead of falling through to the wrong branch.
 * Throws if it is ever reached at runtime.
 */
export function assertNever(value: never): never {
  throw new Error(`unreachable: unexpected value ${JSON.stringify(value)}`);
}
