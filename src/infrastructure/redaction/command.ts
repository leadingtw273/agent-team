import { Redactor, redactedValue } from "./redactor.js";

export interface CommandForLogging {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly workingDirectory?: string;
}

export interface RedactedCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly workingDirectory?: string;
}

const sensitiveFlags = new Set([
  "--api-key",
  "--access-token",
  "--authorization",
  "--client-secret",
  "--cookie",
  "--cookie-jar",
  "--password",
  "--private-key",
  "--secret",
  "--signature",
  "--token",
  "--refresh-token",
  "--webhook-secret",
  "--proxy-user",
  "--user",
  "-b",
  "-u",
]);

function normalizedFlag(argument: string): string {
  return argument
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase()
    .replace(/_/gu, "-");
}

export function redactCommand(command: CommandForLogging, redactor: Redactor): RedactedCommand {
  const arguments_: string[] = [];
  let redactNext = false;
  for (const argument of command.arguments) {
    if (redactNext) {
      arguments_.push(redactedValue);
      redactNext = false;
      continue;
    }

    const equalsIndex = argument.indexOf("=");
    const flag = normalizedFlag(equalsIndex === -1 ? argument : argument.slice(0, equalsIndex));
    const assignmentKey = equalsIndex === -1 ? undefined : argument.slice(0, equalsIndex);
    const splitFlagKey =
      equalsIndex === -1 && flag.startsWith("-") ? flag.replace(/^-+/u, "") : undefined;
    if (
      sensitiveFlags.has(flag) ||
      (splitFlagKey !== undefined && redactor.isSensitiveKey(splitFlagKey)) ||
      (assignmentKey !== undefined && redactor.isSensitiveKey(assignmentKey))
    ) {
      if (equalsIndex === -1) {
        arguments_.push(argument);
        redactNext = true;
      } else {
        arguments_.push(`${argument.slice(0, equalsIndex + 1)}${redactedValue}`);
      }
      continue;
    }
    arguments_.push(redactor.redactText(argument));
  }

  const environment =
    command.environment === undefined
      ? undefined
      : Object.freeze(
          Object.fromEntries(
            Object.entries(command.environment).map(([key, value]) => [
              key,
              redactor.isSensitiveKey(key) ? redactedValue : redactor.redactText(value),
            ]),
          ),
        );

  return Object.freeze({
    executable: redactor.redactText(command.executable),
    arguments: Object.freeze(arguments_),
    ...(environment === undefined ? {} : { environment }),
    ...(command.workingDirectory === undefined
      ? {}
      : { workingDirectory: redactor.redactText(command.workingDirectory) }),
  });
}
