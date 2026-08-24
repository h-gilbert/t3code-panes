/**
 * Instructions steering provider agents toward the T3 Code collaborative
 * browser (`preview_*` tools on the `t3-code` MCP server) over standalone
 * Playwright, Chrome, or other browser automation the agent may also have.
 *
 * Injected per provider: Codex receives it inside its developer instructions
 * (CodexDeveloperInstructions.ts), Claude as a system-prompt append
 * (ClaudeAdapter.ts). Only include it when the `t3-code` MCP server is
 * actually attached to the session: describing `preview_*` tools that aren't
 * in the turn's tool list would be worse than saying nothing, because the
 * text actively steers the model away from the only browser automation it
 * still has.
 */
export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code collaborative browser

You are running inside T3 Code. The \`t3-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates. When the browser work is finished and the user no longer needs the page, call \`preview_close\` so the shared browser does not linger on their screen.

The browser keeps cookies and logins between sessions, so sites the user has signed in to stay signed in — prefer the default shared session for work on the user's accounts. Pass \`profile\` to \`preview_open\` for a separate persistent cookie space, or \`ephemeral: true\` when a test must start from a logged-out, storage-free state.

When a page shows a login form, call \`preview_autofill\` — it types the user's saved login for that exact site directly into the page; the password is never shown to you. If it reports no saved login, ask the user to sign in themselves or save the login via the browser menu. Never ask the user to paste a password into the conversation.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the T3 preview tools are absent, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed T3 preview tool call should be inspected and retried with corrected arguments when the error is actionable.
`;
