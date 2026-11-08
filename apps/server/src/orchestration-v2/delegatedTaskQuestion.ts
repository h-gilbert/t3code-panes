import {
  CommandId,
  MessageId,
  type OrchestrationV2Subagent,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import { reportLabel } from "@t3tools/provider-core/server/notification";

export function delegatedTaskQuestionCommand(
  task: OrchestrationV2Subagent,
  request: OrchestrationV2RuntimeRequest,
) {
  const key = `${task.threadId}:${request.id}`;
  const label = reportLabel(task.title?.trim() || task.prompt);
  const situation =
    request.responseCapability.type === "message"
      ? `Delegated task ${task.id} asked a question and is still working.`
      : `Delegated task ${task.id} is blocked on a question and cannot continue until it is answered.`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`server:delegated-task-question:${key}`),
    threadId: task.threadId,
    messageId: MessageId.make(`message:delegated-task-question:${key}`),
    text: `${situation} Read it with t3_pending_request action read, threadId ${task.remoteChild?.threadId ?? task.childThreadId}${task.remoteChild === undefined ? "" : `, environmentId ${task.remoteChild.environmentId}`}, and requestId ${request.id}. Answer it with action respond when the answer follows from the task or the user's instructions; otherwise ask the user, then answer it. If it is no longer pending, it was answered or dismissed.`,
    notification: {
      source: {
        kind: "delegated_task",
        taskIds: [task.id],
        ...(task.remoteChild !== undefined
          ? {
              childThreadId: task.remoteChild.threadId,
              childEnvironmentId: task.remoteChild.environmentId,
            }
          : task.childThreadId === null
            ? {}
            : { childThreadId: task.childThreadId }),
      },
      outcome: "updated",
      summary: `Delegated task${label === undefined ? "" : ` "${label}"`} has a question`,
    },
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  } as const;
}
