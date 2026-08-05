import type { UiFeatureRegistration } from "../../registry/index.js";
import type { UiRequest } from "../../server/index.js";
import { handleRegistrationSetupApprovalRequest } from "./http.js";
import type { RegistrationSetupApprovalUiUseCase } from "./model.js";
import {
  registrationSetupApprovalApiPath,
  registrationSetupApprovalPagePath,
  registrationSetupFeatureSecurityRoutes,
} from "./routes.js";
import { renderRegistrationSetupApproval } from "./view.js";

export function createRegistrationSetupUiFeatureRegistration(
  useCase: RegistrationSetupApprovalUiUseCase,
): UiFeatureRegistration {
  const contract = registrationSetupFeatureSecurityRoutes[0];
  if (contract === undefined) throw new TypeError("Missing registration Setup route contract.");
  return Object.freeze({
    id: "registration-setup-approval",
    slot: "registration",
    page: Object.freeze({
      path: registrationSetupApprovalPagePath,
      title: "Setup PR 最終核可",
      description: "檢查固定稽核摘要，並在本機工作階段明確核可 Setup PR。",
      render: async () => renderRegistrationSetupApproval(await useCase.read()),
    }),
    routes: Object.freeze([
      Object.freeze({
        contract,
        handler: (request: UiRequest) => handleRegistrationSetupApprovalRequest(useCase, request),
      }),
    ]),
  });
}

export { registrationSetupApprovalApiPath };
