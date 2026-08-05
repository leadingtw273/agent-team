import type { RegistrationReadOnlyScanReadModel } from "../../../application/registration/index.js";
import { containsSensitiveValue } from "../../../infrastructure/redaction/index.js";

export type RegistrationWizardReadModel = RegistrationReadOnlyScanReadModel;

const maximumDisplayLength = 280;
const hiddenText = "已隱藏不安全的原始內容";

/** A final secret-redaction boundary for the fixed Application read model. */
export function safeRegistrationText(value: unknown): string {
  if (typeof value !== "string") return hiddenText;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length === 0 ||
    normalized.length > maximumDisplayLength ||
    containsSensitiveValue(normalized)
    ? hiddenText
    : normalized;
}
