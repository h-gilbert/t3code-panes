/** Browser policy applies even when only external browser tools are available. */
export const T3_CODE_BACKGROUND_BROWSER_INSTRUCTIONS = `

## Background browser work

Run browser automation in the background by default. Keep Playwright and other browser tools available: use headless mode for automated checks, including screenshots, layout checks, and mocked API flows. An isolated browser profile is not headless. Before using a standalone browser MCP for routine automation, check that it runs headlessly; if it only offers a visible browser, use a headless test script or an available background browser instead.

Show a browser when the user explicitly asks to see it or the task requires visible interaction, such as manual sign-in, consent, or a shared walkthrough. Explain why it needs to be visible. Earlier permission to show a login page does not make subsequent regression checks foreground work. Do not activate applications, bring windows or tabs to the front, or use desktop-wide input for routine automation. Resume background work after the visible interaction is finished, without closing a page the user still needs.
`;

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

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` with \`open: false\` for background automation before concluding that the browser is unavailable. Set \`open: true\` only when the user asks to see the page or the task requires visible interaction. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates. Your tab is yours: other agent sessions drive their own tabs in the same browser, and only a session interacting with the very tab you target can block you — retry that step once, rather than abandoning the browser. When the browser work is finished and the user no longer needs the page, call \`preview_close\` so the shared browser does not linger on their screen.

The browser keeps cookies and logins between sessions, so sites the user has signed in to stay signed in — prefer the default shared session for work on the user's accounts. Pass \`profile\` to \`preview_open\` for a separate persistent cookie space, or \`ephemeral: true\` when a test must start from a logged-out, storage-free state.

When a page shows a login form, call \`preview_autofill\` — it types the user's saved login for that exact site directly into the page; the password is never shown to you. If it reports no saved login, ask the user to sign in themselves or save the login via the browser menu. Never ask the user to paste a password into the conversation.

Call autofill before using JavaScript evaluation on a login page. A document that has run agent JavaScript cannot receive a saved login, and JavaScript evaluation is disabled after a password is filled. A full navigation resets either restriction. Continue with snapshots, clicks, typing, key presses, and waits to submit or complete the login. These restrictions do not affect normal browser control.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the T3 preview tools are absent, the user explicitly requests another browser, the task needs capabilities the preview tools do not provide such as request mocking, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed T3 preview tool call should be inspected and retried with corrected arguments when the error is actionable.
`;
