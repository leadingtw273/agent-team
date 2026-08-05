import type { RoleModelFeature } from "./feature.js";
import type { RoleModelSettingsError } from "./schema.js";
import type { RoleModelSettingsSnapshot } from "./use-case.js";

export const roleModelApiPath = "/api/role-models" as const;

export interface RoleModelTypedApiRequest {
  readonly method: string;
  readonly input?: unknown;
}

export type RoleModelTypedApiResponse =
  | Readonly<{ statusCode: 200; body: RoleModelSettingsSnapshot }>
  | Readonly<{ statusCode: 405; body: Readonly<{ error: "method_not_allowed" }> }>
  | Readonly<{
      statusCode: 422;
      body: Readonly<{
        error: "invalid_input" | "unknown_candidate" | "candidate_not_available_for_role";
      }>;
    }>
  | Readonly<{
      statusCode: 503;
      body: Readonly<{
        error:
          | "stored_config_invalid"
          | "active_assignment_invalid"
          | "store_unavailable"
          | "read_back_mismatch";
      }>;
    }>;

function errorResponse(error: RoleModelSettingsError): RoleModelTypedApiResponse {
  switch (error.code) {
    case "invalid_input":
    case "unknown_candidate":
    case "candidate_not_available_for_role":
      return Object.freeze({ statusCode: 422, body: Object.freeze({ error: error.code }) });
    case "stored_config_invalid":
    case "active_assignment_invalid":
    case "store_unavailable":
    case "read_back_mismatch":
      return Object.freeze({ statusCode: 503, body: Object.freeze({ error: error.code }) });
  }
}

/**
 * Transport-neutral endpoint contract. U002's JSON/session adapter owns parsing,
 * authentication and CSRF; this feature only receives already-typed input.
 */
export async function handleRoleModelTypedApiRequest(
  feature: RoleModelFeature,
  request: RoleModelTypedApiRequest,
): Promise<RoleModelTypedApiResponse> {
  switch (request.method) {
    case "GET": {
      const result = await feature.read();
      return result.ok
        ? Object.freeze({ statusCode: 200, body: result.value })
        : errorResponse(result.error);
    }
    case "PUT": {
      const result = await feature.save(request.input);
      return result.ok
        ? Object.freeze({ statusCode: 200, body: result.value })
        : errorResponse(result.error);
    }
    default:
      return Object.freeze({
        statusCode: 405,
        body: Object.freeze({ error: "method_not_allowed" }),
      });
  }
}
