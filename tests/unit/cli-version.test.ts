import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";

const metadata = {
  description: "Local-first agent team controller for Linear and GitHub workflows.",
  version: "0.1.0",
} as const;

describe("agent-team CLI", () => {
  it("prints the package version", () => {
    expect(createProgram(metadata).version()).toBe(metadata.version);
  });

  it("prints help when invoked without arguments", () => {
    let output = "";
    const program = createProgram(metadata).configureOutput({
      writeOut: (message) => {
        output += message;
      },
    });

    program.outputHelp();

    expect(output).toContain("Usage: agent-team [options]");
  });
});
