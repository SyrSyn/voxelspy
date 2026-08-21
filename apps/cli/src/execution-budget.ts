export interface ExecutionBudgetOption {
  readonly maxWorkUnits?: number;
  readonly maxMemoryBytes?: number;
}

/**
 * Builds an optional execution-budget object from CLI-parsed values,
 * omitting keys entirely rather than setting them to `undefined`
 * (`exactOptionalPropertyTypes` in this workspace's tsconfig treats those as
 * different types). Returns `undefined` when neither value was supplied, so
 * the engine falls back to its own built-in ceiling unchanged.
 */
export function buildExecutionBudget(
  maxWorkUnits: number | undefined,
  maxMemoryBytes: number | undefined,
):
  | { readonly maxWorkUnits: number; readonly maxMemoryBytes: number }
  | undefined {
  if (maxWorkUnits === undefined && maxMemoryBytes === undefined)
    return undefined;
  return {
    maxWorkUnits: maxWorkUnits ?? Number.MAX_SAFE_INTEGER,
    maxMemoryBytes: maxMemoryBytes ?? Number.MAX_SAFE_INTEGER,
  };
}
