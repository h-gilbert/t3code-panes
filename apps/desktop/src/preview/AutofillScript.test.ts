import { assert, describe, it } from "@effect/vitest";

import { buildAutofillExpression, decodeAutofillOutcome } from "./AutofillScript.ts";

describe("buildAutofillExpression", () => {
  it("embeds values JSON-escaped so quotes and script tags cannot break out", () => {
    const expression = buildAutofillExpression(`user"</script>`, `pa'ss\\word`);
    assert.include(expression, JSON.stringify(`user"</script>`));
    assert.include(expression, JSON.stringify(`pa'ss\\word`));
    // The raw values must never appear unescaped.
    assert.notInclude(expression, `user"</script>;`);
  });
});

describe("decodeAutofillOutcome", () => {
  it("accepts only the exact outcome shape", () => {
    assert.deepStrictEqual(
      decodeAutofillOutcome({ filled: true, filledPassword: true, filledUsername: false }),
      { filled: true, filledPassword: true, filledUsername: false },
    );
    assert.isNull(decodeAutofillOutcome(null));
    assert.isNull(decodeAutofillOutcome({ filled: "yes" }));
    assert.isNull(decodeAutofillOutcome(undefined));
  });
});
