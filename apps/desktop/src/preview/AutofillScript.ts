/**
 * Page-side script for filling a login form.
 *
 * Values are set through the native `value` setter and followed by `input` /
 * `change` events so framework-controlled inputs (React and friends) accept
 * them. The username field is the nearest text-like input before the
 * password field in the same form; on username-only steps (two-page logins)
 * a single text-like input is filled instead so the flow can proceed.
 */

const TEXT_LIKE_TYPES = new Set(["", "text", "email", "tel", "username"]);

export interface AutofillOutcome {
  readonly filled: boolean;
  readonly filledPassword: boolean;
  readonly filledUsername: boolean;
}

export const buildAutofillExpression = (username: string, password: string): string => {
  const usernameJson = JSON.stringify(username);
  const passwordJson = JSON.stringify(password);
  const textLikeJson = JSON.stringify([...TEXT_LIKE_TYPES]);
  return `(() => {
  const username = ${usernameJson};
  const password = ${passwordJson};
  const textLike = new Set(${textLikeJson});
  const isFillable = (input) =>
    input instanceof HTMLInputElement && !input.disabled && !input.readOnly &&
    input.getClientRects().length > 0;
  const isTextLike = (input) => textLike.has((input.getAttribute("type") || "").toLowerCase());
  const setValue = (input, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const passwordField = Array.from(document.querySelectorAll('input[type="password"]')).find(isFillable) ?? null;
  if (passwordField) {
    const scope = passwordField.form ?? document;
    const inputs = Array.from(scope.querySelectorAll("input")).filter(isFillable);
    const passwordIndex = inputs.indexOf(passwordField);
    const usernameField =
      inputs.slice(0, passwordIndex < 0 ? inputs.length : passwordIndex).reverse().find(isTextLike) ?? null;
    if (usernameField) setValue(usernameField, username);
    setValue(passwordField, password);
    return { filled: true, filledPassword: true, filledUsername: usernameField !== null };
  }
  // Username-only step (two-page logins): fill the single text-like input.
  const textInputs = Array.from(document.querySelectorAll("input")).filter(
    (input) => isFillable(input) && isTextLike(input),
  );
  if (textInputs.length === 1) {
    setValue(textInputs[0], username);
    return { filled: true, filledPassword: false, filledUsername: true };
  }
  return { filled: false, filledPassword: false, filledUsername: false };
})()`;
};

export const decodeAutofillOutcome = (value: unknown): AutofillOutcome | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return typeof record.filled === "boolean" &&
    typeof record.filledPassword === "boolean" &&
    typeof record.filledUsername === "boolean"
    ? {
        filled: record.filled,
        filledPassword: record.filledPassword,
        filledUsername: record.filledUsername,
      }
    : null;
};
