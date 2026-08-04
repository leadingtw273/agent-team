import { describe, expect, it } from "vitest";

import {
  createUnavailableFakeAdapterPorts,
  missingAdapterPortMethods,
} from "./support/adapter-port-contract.js";

describe("application adapter ports", () => {
  it("accepts compile-only fake adapters for every external boundary", () => {
    const ports = createUnavailableFakeAdapterPorts();

    expect(missingAdapterPortMethods(ports)).toEqual([]);
    expect(Object.keys(ports).sort()).toEqual([
      "git",
      "process",
      "provider",
      "quota",
      "sourceControl",
      "workManagement",
    ]);
  });
});
