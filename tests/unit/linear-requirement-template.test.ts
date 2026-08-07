/**
 * C015b unit tests: `parseReadyGateTemplate` (src/adapters/linear/requirement-template.ts) --
 * the parser closing C015a's escalated "issue projection" gap. Covers: a fully-filled template
 * (every field extractable, including `changeRegions`), a partially-filled template
 * (only-required-fields), a description that never used the template at all (everything absent,
 * no crash), untouched placeholder text treated as not-filled, the three-way `dependencies`
 * outcome (none/unparsed/absent), and estimatedMinutes extraction robustness (first integer wins,
 * no digits leaves it absent).
 */
import { describe, expect, it } from "vitest";

import { parseReadyGateTemplate } from "../../src/adapters/linear/requirement-template.js";
import { readyGateTemplateHeadings } from "../../src/application/registration/linear-provision-model.js";

function filledTemplate(overrides: Readonly<Record<string, string>> = {}): string {
  const dependencies = overrides["dependencies"] ?? "無";
  return `## ${readyGateTemplateHeadings.goal}
讓派工管線能吃到真實 Linear 資料。

## ${readyGateTemplateHeadings.background}
C015a 發現沒有解析器，C015b 補上。

## ${readyGateTemplateHeadings.acceptanceCriteria}
- 完整範本可以解析成功
- 缺欄位不會讓整支程式崩潰

## ${readyGateTemplateHeadings.inScope}
- 撰寫解析器
- 撰寫測試

## ${readyGateTemplateHeadings.outOfScope}
- 不修改引擎

## ${readyGateTemplateHeadings.dependencies}
${dependencies}

## ${readyGateTemplateHeadings.estimatedMinutes}
目標 30 分鐘

## ${readyGateTemplateHeadings.constraints}
- 不得修改引擎

## ${readyGateTemplateHeadings.risks}
- 範本格式漂移

## ${readyGateTemplateHeadings.changeRegions}
- src/adapters/linear/requirement-template.ts`;
}

describe("parseReadyGateTemplate", () => {
  it("extracts every field from a fully-filled template", () => {
    const result = parseReadyGateTemplate(filledTemplate());
    expect(result).toEqual({
      goal: "讓派工管線能吃到真實 Linear 資料。",
      background: "C015a 發現沒有解析器，C015b 補上。",
      acceptanceCriteria: ["完整範本可以解析成功", "缺欄位不會讓整支程式崩潰"],
      inScope: ["撰寫解析器", "撰寫測試"],
      outOfScope: ["不修改引擎"],
      estimatedMinutes: 30,
      constraints: ["不得修改引擎"],
      risks: ["範本格式漂移"],
      changeRegions: [{ path: "src/adapters/linear/requirement-template.ts", coverage: "exact" }],
      dependencies: { kind: "none" },
    });
  });

  it("parses multiple changeRegions bullet lines, each as coverage:exact", () => {
    const description = `## ${readyGateTemplateHeadings.changeRegions}
- src/a.ts
- src/b.ts`;
    const result = parseReadyGateTemplate(description);
    expect(result.changeRegions).toEqual([
      { path: "src/a.ts", coverage: "exact" },
      { path: "src/b.ts", coverage: "exact" },
    ]);
  });

  it("leaves changeRegions absent when the section is empty or only the placeholder", () => {
    const description = `## ${readyGateTemplateHeadings.changeRegions}
- （請填寫）`;
    expect(parseReadyGateTemplate(description).changeRegions).toBeUndefined();
  });

  it("leaves every optional field absent for a description that never used the template", () => {
    const result = parseReadyGateTemplate("這是一段完全沒有套用範本的自由文字描述。");
    expect(result).toEqual({ dependencies: { kind: "absent" } });
  });

  it("leaves every field absent when description itself is undefined", () => {
    expect(parseReadyGateTemplate(undefined)).toEqual({ dependencies: { kind: "absent" } });
  });

  it("treats untouched placeholder bullets/text as not-filled-in, not real content", () => {
    const description = `## ${readyGateTemplateHeadings.goal}

## ${readyGateTemplateHeadings.acceptanceCriteria}
- （請填寫）

## ${readyGateTemplateHeadings.dependencies}
`;
    const result = parseReadyGateTemplate(description);
    expect(result.goal).toBeUndefined();
    expect(result.acceptanceCriteria).toBeUndefined();
    expect(result.dependencies).toEqual({ kind: "none" });
  });

  it("only extracts the required fields when optional sections are left blank", () => {
    const description = `## ${readyGateTemplateHeadings.goal}
目標文字

## ${readyGateTemplateHeadings.background}
背景文字

## ${readyGateTemplateHeadings.acceptanceCriteria}
- 驗收條件一

## ${readyGateTemplateHeadings.inScope}
- 範圍內一

## ${readyGateTemplateHeadings.outOfScope}
- 範圍外一

## ${readyGateTemplateHeadings.dependencies}
無

## ${readyGateTemplateHeadings.estimatedMinutes}
20

## ${readyGateTemplateHeadings.constraints}

## ${readyGateTemplateHeadings.risks}

## ${readyGateTemplateHeadings.changeRegions}
`;
    const result = parseReadyGateTemplate(description);
    expect(result).toEqual({
      goal: "目標文字",
      background: "背景文字",
      acceptanceCriteria: ["驗收條件一"],
      inScope: ["範圍內一"],
      outOfScope: ["範圍外一"],
      estimatedMinutes: 20,
      dependencies: { kind: "none" },
    });
  });

  describe("dependencies three-way outcome", () => {
    it("maps an empty dependencies section to kind:none", () => {
      const description = `## ${readyGateTemplateHeadings.dependencies}

## ${readyGateTemplateHeadings.constraints}`;
      expect(parseReadyGateTemplate(description).dependencies).toEqual({ kind: "none" });
    });

    it('maps a dependencies section containing only "無" to kind:none', () => {
      const description = `## ${readyGateTemplateHeadings.dependencies}
無`;
      expect(parseReadyGateTemplate(description).dependencies).toEqual({ kind: "none" });
    });

    it("maps a dependencies section with any other text to kind:unparsed, never guessing issue ids", () => {
      const description = `## ${readyGateTemplateHeadings.dependencies}
依賴 ENG-42 先完成`;
      expect(parseReadyGateTemplate(description).dependencies).toEqual({ kind: "unparsed" });
    });

    it("maps a missing dependencies heading to kind:absent, distinct from an empty section", () => {
      const description = `## ${readyGateTemplateHeadings.goal}
只填了目標`;
      expect(parseReadyGateTemplate(description).dependencies).toEqual({ kind: "absent" });
    });
  });

  describe("estimatedMinutes extraction", () => {
    it("takes the first integer found in the section text", () => {
      const description = `## ${readyGateTemplateHeadings.estimatedMinutes}
大約 30 到 45 分鐘`;
      expect(parseReadyGateTemplate(description).estimatedMinutes).toBe(30);
    });

    it("leaves estimatedMinutes absent when no digit is present", () => {
      const description = `## ${readyGateTemplateHeadings.estimatedMinutes}
很快`;
      expect(parseReadyGateTemplate(description).estimatedMinutes).toBeUndefined();
    });
  });
});
