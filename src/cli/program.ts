import { Command } from "commander";

export interface PackageMetadata {
  readonly description: string;
  readonly version: string;
}

export function createProgram(metadata: PackageMetadata): Command {
  return new Command()
    .name("agent-team")
    .description(metadata.description)
    .version(metadata.version)
    .showHelpAfterError();
}
