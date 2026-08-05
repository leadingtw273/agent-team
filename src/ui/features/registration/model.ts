import type { RegistrationReadOnlyScanReadModel } from "../../../application/registration/index.js";
import { containsSensitiveValue } from "../../../infrastructure/redaction/index.js";

export type RegistrationWizardReadModel = RegistrationReadOnlyScanReadModel;

const maximumDisplayLength = 280;
const hiddenText = "已隱藏不安全的原始內容";
const unsafeRegistrationTextPattern =
  /(?:authorization\s*[:=]|bearer\s+[a-z0-9._~+/=-]+|(?:api[_ -]?key|secret|token|password)\s*[:=]|-----begin|(?:^|\s)(?:(?:curl|wget|rm|bash|zsh|sh)\s+|git\s+(?:reset|clean|checkout|switch|push|commit|merge|rebase)\b|node\s+--|pnpm\s+(?:run|exec|install|add|remove|test)\b)|hidden\s+reasoning|chain\s+of\s+thought)/iu;

/** A final UI boundary in case a caller bypasses the Application read model. */
export function safeRegistrationText(value: unknown): string {
  if (typeof value !== "string") return hiddenText;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length === 0 ||
    normalized.length > maximumDisplayLength ||
    containsSensitiveValue(normalized) ||
    unsafeRegistrationTextPattern.test(normalized)
    ? hiddenText
    : normalized;
}
