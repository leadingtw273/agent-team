import { describe, expect, it } from "vitest";

import {
  createRegistrationWizardUiFeatureRegistration,
  fixtureRegistrationReadOnlyScanUseCase,
  registrationWizardCssPath,
  registrationWizardPagePath,
  renderRegistrationWizard,
  safeRegistrationText,
  type RegistrationWizardReadModel,
} from "../../src/ui/features/registration/index.js";

function joined(...parts: readonly string[]): string {
  return parts.join("");
}

describe("O002 registration wizard UI", () => {
  it("renders every O001 Gate through a content-only registration with evidence and repair", async () => {
    const registration = createRegistrationWizardUiFeatureRegistration(
      fixtureRegistrationReadOnlyScanUseCase,
    );
    const content = await registration.page.render();
    const scan = await fixtureRegistrationReadOnlyScanUseCase.scan();

    expect(registration).toMatchObject({
      id: "registration-wizard",
      slot: "registration",
      page: { path: registrationWizardPagePath, styles: [registrationWizardCssPath] },
    });
    expect(registration.page.scripts).toBeUndefined();
    expect(registration.routes.map((route) => route.contract.path)).toEqual([
      registrationWizardCssPath,
    ]);
    expect(registration.routes[0]?.contract.allowedMethods).toEqual(["GET"]);
    expect(content).toContain("這是合成示範資料");
    expect(content).toContain("不建立 PR、不變更 GitHub／Linear／CI／Webhook");
    expect(content).toContain("O002 只執行 7 項 read-only scan");
    expect(content).not.toContain("<html");
    expect(content).not.toContain("<form");
    expect(content).not.toContain("/api/registration");
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
