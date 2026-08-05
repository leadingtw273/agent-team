import { describe, expect, it } from "vitest";

import {
  createFixtureRegistrationWizardUiFeatureRegistration,
  fixtureRegistrationReadOnlyScanUseCase,
  githubRegistrationPolicyApiPath,
  githubRegistrationPolicyScriptPath,
  linearProvisionApiPath,
  registrationWizardCssPath,
  registrationWizardPagePath,
  registrationWizardScriptPath,
  renderRegistrationWizard,
  safeRegistrationText,
  type RegistrationWizardReadModel,
} from "../../src/ui/features/registration/index.js";
import {
  registrationSetupApiPath,
  registrationSetupCssPath,
  registrationSetupScriptPath,
} from "../../src/ui/features/registration-setup/index.js";

function joined(...parts: readonly string[]): string {
  return parts.join("");
}

describe("O002/O003/O004 registration wizard UI", () => {
  it("keeps every O001 Gate and composes the Linear and GitHub previews in the same Registry feature", async () => {
    const registration = createFixtureRegistrationWizardUiFeatureRegistration(
      fixtureRegistrationReadOnlyScanUseCase,
    );
    const content = await registration.page.render({
      session: { authorityDigest: "a".repeat(64) },
    });
    const scan = await fixtureRegistrationReadOnlyScanUseCase.scan();

    expect(registration).toMatchObject({
      id: "registration-wizard",
      slot: "registration",
      page: {
        path: registrationWizardPagePath,
        styles: [registrationWizardCssPath, registrationSetupCssPath],
        scripts: [
          registrationWizardScriptPath,
          githubRegistrationPolicyScriptPath,
          registrationSetupScriptPath,
        ],
      },
    });
    expect(registration.routes.map((route) => route.contract.path)).toEqual([
      registrationWizardCssPath,
      registrationWizardScriptPath,
      githubRegistrationPolicyScriptPath,
      registrationSetupCssPath,
      registrationSetupScriptPath,
      registrationSetupApiPath,
      linearProvisionApiPath,
      githubRegistrationPolicyApiPath,
    ]);
    expect(registration.routes[0]?.contract.allowedMethods).toEqual(["GET"]);
    expect(registration.routes[5]?.contract).toMatchObject({
      allowedMethods: ["GET", "PUT"],
      mutationBody: "bounded-json",
    });
    expect(registration.routes[6]?.contract).toMatchObject({
      allowedMethods: ["GET", "PUT"],
      mutationBody: "bounded-json",
    });
    expect(registration.routes[7]?.contract).toMatchObject({
      allowedMethods: ["PUT"],
      mutationBody: "bounded-json",
    });
    expect(content).toContain("這是合成示範資料");
    expect(content).toContain("O002 掃描仍只讀");
    expect(content).toContain("O002 只執行 7 項 read-only scan");
    expect(content).toContain("Linear 設定預覽");
    expect(content).toContain("第二步確認");
    expect(content).toContain("不刪除、不改名");
    expect(content).toContain("GitHub 合併保護");
    expect(content).toContain("現有保護規則不會被修改或刪除");
    expect(content).toContain("可信設定 Setup");
    expect(content).toContain("production_dependencies_unwired");
    expect(content).not.toContain("<html");
    expect(content).not.toContain("<form");
    expect(scan.gates).toHaveLength(11);
    for (const gate of scan.gates) {
      expect(content).toContain(gate.label);
      expect(content).toContain(gate.evidence[0] ?? "");
      expect(content).toContain(gate.repair);
    }
  });

  it("has a final rendering redaction boundary for mistaken external read-model data", async () => {
    const source = await fixtureRegistrationReadOnlyScanUseCase.scan();
    const marker = joined("github", "_pat_", "abcdefghijklmnopqrstuvwxyz");
    const unsafeGate = source.gates[0];
    if (unsafeGate === undefined)
      throw new Error("Registration fixture must contain a local gate.");
    const unsafeReadModel: RegistrationWizardReadModel = Object.freeze({
      ...source,
      gates: Object.freeze([
        Object.freeze({
          ...unsafeGate,
          label: `Authorization: Bearer ${marker}`,
          scope: `secret scope ${marker}` as typeof unsafeGate.scope,
          evidence: Object.freeze([`Authorization: Bearer ${marker}`]),
          repair: `curl https://runtime.invalid --header '${marker}'`,
          observedAt: "https://user:password@example.test/?secret=value",
          provenance: `secret provenance ${marker}` as typeof unsafeGate.provenance,
          rawOutput: marker,
          hiddenReasoning: "internal chain of thought",
        }),
        ...source.gates.slice(1),
      ]),
    });

    const html = renderRegistrationWizard(unsafeReadModel);

    expect(html).toContain("已隱藏不安全的原始內容");
    expect(html).not.toContain(marker);
    expect(html).not.toContain("curl https://runtime.invalid");
    expect(html).not.toContain("user:password");
    expect(html).not.toContain("internal chain of thought");
  });

  it("keeps fixed-model text readable and leaves command exclusion to the typed Application boundary", () => {
    expect(safeRegistrationText("已確認本機 Git Repository；Node.js 24.x 符合要求。")).toBe(
      "已確認本機 Git Repository；Node.js 24.x 符合要求。",
    );
    expect(safeRegistrationText("git status")).toBe("git status");
    expect(safeRegistrationText("Authorization: Bearer secret-value")).toBe(
      "已隱藏不安全的原始內容",
    );
  });
});
