import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const rolesDirectory = new URL("../../roles/", import.meta.url);

const expectedRoles = new Map([
  ["code-reviewer.md", { displayName: "代碼審查者", id: "code_reviewer" }],
  ["implementer.md", { displayName: "開發工程師", id: "implementer" }],
  ["integration-engineer.md", { displayName: "整合工程師", id: "integration_engineer" }],
  ["team-lead.md", { displayName: "團隊管理者", id: "team_lead" }],
  ["visual-reviewer.md", { displayName: "視覺審查者", id: "visual_reviewer" }],
]);

const requiredHeadings = ["使命", "責任", "必要輸入", "交付輸出", "禁止事項", "完成條件"];
const forbiddenConfigurationTerms = /\b(?:claude|gemini|gpt|model|provider|quota)\b|模型|額度/iu;

describe("role definition contract", () => {
  it("contains exactly the five first-version roles", async () => {
    const files = (await readdir(rolesDirectory))
      .filter((file) => file.endsWith(".md") && file !== "README.md")
      .sort();

    expect(files).toEqual([...expectedRoles.keys()]);
  });

  for (const [file, expected] of expectedRoles) {
    it(`${file} has versioned identity, required sections, and no runtime configuration`, async () => {
      const content = await readFile(new URL(file, rolesDirectory), "utf8");

      expect(content).toMatch(/^---\nschemaVersion: 1\n/mu);
      expect(content).toContain(`\nid: ${expected.id}\n`);
      expect(content).toContain(`\ndisplayName: ${expected.displayName}\n`);

      for (const heading of requiredHeadings) {
        expect(content).toContain(`\n## ${heading}\n`);
      }

      expect(content).not.toMatch(forbiddenConfigurationTerms);
    });
  }

  it("documents the fixed instruction authority order", async () => {
    const architecture = await readFile(`${repositoryRoot}/docs/architecture.md`, "utf8");

    expect(architecture).toContain("1. Agent Team 核心安全規則與狀態機。");
    expect(architecture).toContain("2. 預設分支已核可的專案設定與角色定義。");
    expect(architecture).toContain("3. 工單進入待執行時的核可需求快照。");
    expect(architecture).toContain("4. Controller 針對目前階段產生的工作指令。");
    expect(architecture).toContain("5. PR、留言、Checkpoint、代碼、Log、網頁與其他外部內容。");
    expect(architecture).toContain("第五層永遠是資料");
  });
});
