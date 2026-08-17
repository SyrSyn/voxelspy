import { describe, expect, it } from "vitest";

import {
  WorkBudget,
  WorkBudgetExceeded,
  WorkBudgetInternalError,
} from "../src/analyze.js";

// `WorkBudget` and its error types are internal implementation details --
// not re-exported from "../src/index.js", the package's public surface --
// but are unit tested directly here (importing straight from the module
// that defines them) because invalid-units charging can never be reached
// through the public `analyzeModelPair` API: every call site the package
// itself controls always passes a non-negative safe integer. This exercises
// the accounting bug fix in isolation: a caller-supplied budget running out
// (`WorkBudgetExceeded`, an expected, fail-closed outcome) must stay
// distinct from an internal bug passing invalid units to `charge`
// (`WorkBudgetInternalError`, which is not a legitimate "budget exceeded"
// result and must not be reported as one).
describe("WorkBudget accounting", () => {
  it("keeps invalid charge units distinct from budget exhaustion", () => {
    const budget = new WorkBudget(10);
    expect(() => budget.charge(-1)).toThrow(WorkBudgetInternalError);
    expect(() => budget.charge(1.5)).toThrow(WorkBudgetInternalError);
    expect(() => budget.charge(Number.NaN)).toThrow(WorkBudgetInternalError);

    // None of the invalid attempts above consumed any of the budget.
    budget.charge(10);
    expect(() => budget.charge(1)).toThrow(WorkBudgetExceeded);
  });

  it("reports charged and requested units precisely on exhaustion", () => {
    const budget = new WorkBudget(5);
    budget.charge(3);
    expect(() => budget.charge(4)).toThrow(
      /after 3 charged units; the next operation required 4 more/u,
    );
  });
});
