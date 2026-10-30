import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

export const CredentialRequest = Schema.Struct({
  name: TrimmedNonEmptyString,
  kind: Schema.Literals(["login", "secret"]),
  website: Schema.optional(TrimmedNonEmptyString),
  replace: Schema.optional(Schema.Boolean),
});
export type CredentialRequest = typeof CredentialRequest.Type;

export const CredentialMetadata = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["login", "secret"]),
  website: Schema.optional(Schema.String),
  scope: Schema.Literals(["project", "environment"]),
  projectId: ProjectId,
  updatedAt: Schema.Number,
});
export type CredentialMetadata = typeof CredentialMetadata.Type;
export const CredentialsListResult = Schema.Struct({
  credentials: Schema.Array(CredentialMetadata),
});
export const CredentialRemoveInput = Schema.Struct({ id: TrimmedNonEmptyString });

/** Server stores the value under a one-use SecretRef; the thread learns only status. */
export const SecretRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("save"),
      secret: Schema.String.check(Schema.isMinLength(1)),
      username: Schema.optional(TrimmedNonEmptyString),
      scope: Schema.optional(Schema.Literals(["project", "environment"])),
    }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type SecretRequestAnswerInput = typeof SecretRequestAnswerInput.Type;

const SECRET_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the secret request.",
  not_found: "This secret request no longer exists.",
  already_answered: "This secret request was already answered.",
  agent_stopped: "The agent that asked has stopped, so this secret can't be used.",
  store_failed: "Could not store the secret.",
  record_failed: "Saved the secret, but could not update the request.",
  invalid_ref: "That secretRef is not valid.",
  read_failed: "Could not read the secret.",
  ref_unavailable:
    "That secretRef was already used or does not exist. Ask the user again with request_secret.",
  ref_expired: "That secretRef expired. Ask the user again with request_secret.",
  consume_failed: "Could not use that secretRef. Try again.",
  not_a_file_request:
    'The user did not save this secret for shell use. Ask again with request_secret and delivery: "file".',
  credential_failed: "Could not access the credential vault. Try again.",
  username_required: "Enter the login username or email.",
} as const;

export const SecretRequestFailureReason = Schema.Literals(
  Object.keys(SECRET_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof SECRET_REQUEST_FAILURE_MESSAGES
  >,
);
export type SecretRequestFailureReason = typeof SecretRequestFailureReason.Type;

export class SecretRequestError extends Schema.TaggedError<SecretRequestError>()(
  "SecretRequestError",
  {
    reason: SecretRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return SECRET_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
