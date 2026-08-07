/**
 * C015b unit tests: `parseReadyGateTemplate` (src/adapters/linear/requirement-template.ts) --
 * the parser closing C015a's escalated "issue projection" gap. Covers: a fully-filled template
 * (every field extractable, including `changeRegions`), a partially-filled template
 * (only-required-fields), a description that never used the template at all (everything absent,
 * no crash), untouched placeholder text treated as not-filled, the three-way `dependencies`
 * outcome (none/unparsed/absent), `estimatedMinutes`'s pure-digits-only rule (an acceptance
 * review found the original "first integer anywhere" rule silently misparsed ordinary Chinese
 * input like "2小時" in the unsafe direction -- every adversarial case that review found is
 * pinned down here), duplicate-heading fail-closed handling (FAIL-B), and fenced-code-block
 * awareness (the same review's FAIL-B same-source finding: a `##`-looking line inside a ```
 * fence must never be treated as a real section boundary).
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
30

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

  describe("estimatedMinutes extraction (FAIL-A: pure-digits-only, never guess through units/signs/notation)", () => {
    function estimatedMinutesFor(text: string): number | undefined {
      const description = `## ${readyGateTemplateHeadings.estimatedMinutes}\n${text}`;
      return parseReadyGateTemplate(description).estimatedMinutes;
    }

    it("accepts a bare integer", () => {
      expect(estimatedMinutesFor("30")).toBe(30);
    });

    it.each([
      ["2小時", "unit word directly appended with no space"],
      ["3 小時", "unit word with a preceding space"],
      ["約 2 小時（120 分鐘）", "annotated multi-number text -- the real review case"],
      ["約2小時", "unit word with a leading qualifier and no space"],
      ["-5", "a leading minus sign must not be silently dropped"],
      ["1e9", "scientific notation must not be silently truncated"],
      ["0", "zero is not a positive estimate"],
      ["abc", "no digits at all"],
    ])("leaves estimatedMinutes undefined for %s (%s)", (text) => {
      expect(estimatedMinutesFor(text)).toBeUndefined();
    });

    it("leaves estimatedMinutes absent when no digit is present", () => {
      expect(estimatedMinutesFor("很快")).toBeUndefined();
    });
  });

  describe("duplicate headings (FAIL-B: repeated section must never resolve via last-wins)", () => {
    it("flips dependencies to unparsed (fail-closed) when the heading appears twice, even if the later occurrence says 無", () => {
      // The exact adversarial shape from the acceptance review: a real dependency declared
      // first, silently "overwritten" by a later, unrelated 無 section.
      const description = `## ${readyGateTemplateHeadings.dependencies}
需要 ISSUE-1 先完成

## ${readyGateTemplateHeadings.risks}
- r

## ${readyGateTemplateHeadings.dependencies}
無`;
      expect(parseReadyGateTemplate(description).dependencies).toEqual({ kind: "unparsed" });
    });

    it("flips dependencies to unparsed even when the first occurrence already says 無 and the second repeats it", () => {
      const description = `## ${readyGateTemplateHeadings.dependencies}
無

## ${readyGateTemplateHeadings.dependencies}
無`;
      expect(parseReadyGateTemplate(description).dependencies).toEqual({ kind: "unparsed" });
    });

    it("leaves a duplicated non-dependencies field undefined (missing_X blocker), not the last occurrence's text", () => {
      const description = `## ${readyGateTemplateHeadings.goal}
第一次目標

## ${readyGateTemplateHeadings.goal}
第二次目標`;
      expect(parseReadyGateTemplate(description).goal).toBeUndefined();
    });

    it("leaves a duplicated estimatedMinutes undefined even when both occurrences are individually valid", () => {
      const description = `## ${readyGateTemplateHeadings.estimatedMinutes}
20

## ${readyGateTemplateHeadings.estimatedMinutes}
30`;
      expect(parseReadyGateTemplate(description).estimatedMinutes).toBeUndefined();
    });

    it("does not flag a heading that genuinely appears only once", () => {
      const description = `## ${readyGateTemplateHeadings.dependencies}
無

## ${readyGateTemplateHeadings.risks}
- only one risks section`;
      const result = parseReadyGateTemplate(description);
      expect(result.dependencies).toEqual({ kind: "none" });
      expect(result.risks).toEqual(["only one risks section"]);
    });
  });

  describe("fenced code blocks (FAIL-B same-source: a heading-looking line inside ``` or ~~~ is never a real section boundary)", () => {
    it("ignores a fake dependencies heading inside a fenced code block", () => {
      const description = `## ${readyGateTemplateHeadings.dependencies}
無

## ${readyGateTemplateHeadings.risks}
以下是範本格式範例：
\`\`\`
## ${readyGateTemplateHeadings.dependencies}
需要 ISSUE-1 先完成
\`\`\`
- 真正的風險項目`;
      const result = parseReadyGateTemplate(description);
      // The load-bearing assertion: dependencies stays "none" -- the fake heading inside the
      // fence never created a second (real) 依賴關係 section, so FAIL-B's duplicate-heading
      // rule never even triggers here.
      expect(result.dependencies).toEqual({ kind: "none" });
      // The fenced lines are ordinary body text within "risks" (not bullet lines, so
      // parseBulletList's own filter drops them) -- only the genuine bullet survives.
      expect(result.risks).toEqual(["真正的風險項目"]);
    });

    it("does not let an unclosed fence's trailing fake heading leak into the real dependencies section", () => {
      // Even with no closing ``` at all, the fake heading inside the (permanently open) fence
      // must never be treated as a real section boundary.
      const description = `## ${readyGateTemplateHeadings.dependencies}
無

## ${readyGateTemplateHeadings.risks}
\`\`\`
## ${readyGateTemplateHeadings.dependencies}
需要 ISSUE-1 先完成`;
      const result = parseReadyGateTemplate(description);
      expect(result.dependencies).toEqual({ kind: "none" });
    });

    it("still recognizes a real heading that follows a properly closed fence", () => {
      const description = `## ${readyGateTemplateHeadings.risks}
\`\`\`
## fake heading inside fence
\`\`\`

## ${readyGateTemplateHeadings.dependencies}
無`;
      const result = parseReadyGateTemplate(description);
      expect(result.dependencies).toEqual({ kind: "none" });
    });

    it("ignores a fake goal heading inside a ~~~ fence -- the exact adversarial case an acceptance review found forged a real goal", () => {
      const description = `## ${readyGateTemplateHeadings.goal}

## ${readyGateTemplateHeadings.risks}
~~~
## ${readyGateTemplateHeadings.goal}
偽造的目標，來自 ~~~ 圍欄內的範例文字
~~~
- 真正的風險項目`;
      const result = parseReadyGateTemplate(description);
      // The load-bearing assertion: goal stays absent -- the fake "## 目標" inside the ~~~
      // fence must never forge a real goal section.
      expect(result.goal).toBeUndefined();
      expect(result.risks).toEqual(["真正的風險項目"]);
    });

    it("does not let an unclosed ~~~ fence's trailing fake heading leak into the real dependencies section", () => {
      const description = `## ${readyGateTemplateHeadings.dependencies}
無

## ${readyGateTemplateHeadings.risks}
~~~
## ${readyGateTemplateHeadings.dependencies}
需要 ISSUE-1 先完成`;
      const result = parseReadyGateTemplate(description);
      expect(result.dependencies).toEqual({ kind: "none" });
    });

    it("does not let a mismatched ``` / ~~~ marker close a fence -- only a matching marker closes it", () => {
      // Opened with ```, a ~~~ line appears inside (must NOT close the fence), then the fake
      // heading, then finally a matching ``` closes it. If markers were treated as
      // interchangeable (a naive single toggle), the ~~~ line would wrongly close the fence and
      // let the fake heading below it forge a real dependencies section.
      const description = `## ${readyGateTemplateHeadings.dependencies}
無

## ${readyGateTemplateHeadings.risks}
\`\`\`
~~~
## ${readyGateTemplateHeadings.dependencies}
需要 ISSUE-1 先完成
\`\`\`
- 真正的風險項目`;
      const result = parseReadyGateTemplate(description);
      expect(result.dependencies).toEqual({ kind: "none" });
      expect(result.risks).toEqual(["真正的風險項目"]);
    });
  });
});
