import type { RegistrationReadOnlyScanReadModel } from "../../../application/registration/index.js";
import { containsSensitiveValue } from "../../../infrastructure/redaction/index.js";

export type RegistrationWizardReadModel = RegistrationReadOnlyScanReadModel;

const maximumDisplayLength = 280;
const hiddenText = "已隱藏不安全的原始內容";
const unsafeRegistrationTextPattern =
  /(?:authorization\s*[:=]|bearer\s+[a-z0-9._~+/=-]+|(?:api[_ -]?key|secret|token|password)\s*[:=]|-----begin|hidden\s+reasoning|chain\s+of\s+thought)/iu;
const completeCommandPattern =
  /(?:^|\s)(?:gh|curl|wget|git|systemctl|node|pnpm|npm|npx|yarn|bun|codex|claude|gemini|bash|zsh|sh|rm)\s+\S/u;

/** A final UI boundary in case a caller bypasses the Application read model. */
export function safeRegistrationText(value: unknown): string {
  if (typeof value !== "string") return hiddenText;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length === 0 ||
    normalized.length > maximumDisplayLength ||
    containsSensitiveValue(normalized) ||
    unsafeRegistrationTextPattern.test(normalized) ||
    completeCommandPattern.test(normalized)
    ? hiddenText
    : normalized;
}
