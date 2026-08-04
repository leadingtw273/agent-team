export function parseLinearApiKey(raw: string): string;
export function isSecureSecretFile(
  metadata: { isFile(): boolean; mode: number; uid: number },
  currentUserId: number,
): boolean;
export function classifyGraphqlOutcome(
  status: number,
  body: unknown,
): { ok: true; error: null } | { ok: false; error: string };
export function classifyNonJsonOutcome(status: number): string;
export function sanitizeProbeName(value: unknown): "inventory" | "roundtrip" | "invalid_mode";
