import { object } from './orchestration.ts';
import type { Context } from './orchestration.ts';
import { context, toolId } from './orchestration-journal.ts';

export type HistoryEvent = Context & { readonly event: { readonly type: string; readonly message?: unknown } };

export function withMessageOwner(message: unknown, owner?: Context): unknown {
  if (!object(message) || !['user', 'assistant', 'toolResult'].includes(String(message.role))) return message;
  // This public field is supplied only by a matched, host-owned journal context.
  const {athena: _unverified, ...content} = message;
  return owner ? {...content, athena: context(owner)} : Object.hasOwn(message, 'athena') ? content : message;
}

function withToolIds(message: unknown, attempt: Context): unknown {
  if (!object(message)) return message;
  if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
    return {...message, toolCallId: toolId(attempt, message.toolCallId), rawToolCallId: message.toolCallId};
  }
  if (message.role === 'assistant' && Array.isArray(message.content)) {
    return {...message, content: message.content.map((part: unknown) =>
      object(part) && part.type === 'toolCall' && typeof part.id === 'string'
        ? {...part, id: toolId(attempt, part.id), rawToolCallId: part.id}
        : part)};
  }
  return message;
}

function isTurnAnchor(message: unknown): boolean {
  return object(message) && (message.role === 'user' || (message.role === 'custom' &&
    message.customType === 'athena-reconciliation' && message.display === false));
}

export type DisplayAttachment = { readonly name: string; readonly mimeType: string; readonly size: number };
export type AttachmentMessage = { readonly dispatch: string; readonly user: string; readonly manuscriptHandoff?: boolean; readonly attachments?: readonly DisplayAttachment[] };

/** Match the exact dispatch for the owning attempt, including any public redaction. */
export function withoutAttachmentContext(message: unknown, attachment: AttachmentMessage | undefined): unknown {
  if (!attachment || !object(message) || message.role !== 'user') return message;
  const metadata = { ...(attachment.attachments ? {attachments: attachment.attachments} : {}), ...(attachment.manuscriptHandoff ? {manuscriptHandoff: true} : {}) };
  if (message.content === attachment.dispatch) return {...message, content: attachment.user, ...metadata};
  if (Array.isArray(message.content) && message.content.length === 1) {
    const [part] = message.content;
    if (object(part) && part.type === 'text' && part.text === attachment.dispatch)
      return {...message, content: [{...part, text: attachment.user}], ...metadata};
  }
  return message;
}

/** Match finalized messages inside an unambiguous user or host continuation turn. */
export function projectHistory(messages: readonly unknown[], journal: readonly HistoryEvent[],
  projectUser: (message: unknown, attempt: Context) => unknown = message => message,
  linkTools = true): readonly unknown[] {
  type Turn = { readonly attempt: Context; readonly messages: unknown[] };
  const journalTurns = new Map<string, Turn[]>();
  const byAttempt = new Map<string, Turn>();
  for (const row of journal) {
    const {type, message} = row.event;
    if (type !== 'message_end' || !object(message)) continue;
    if (isTurnAnchor(message)) {
      const key = JSON.stringify(message);
      const turn: Turn = {attempt: row, messages: []};
      const turns = journalTurns.get(key);
      if (turns) turns.push(turn);
      else journalTurns.set(key, [turn]);
      byAttempt.set(row.attemptId, turn);
    } else {
      byAttempt.get(row.attemptId)?.messages.push(message);
    }
  }
  if (!journalTurns.size) return messages.map(message => withMessageOwner(message));

  const anchorCounts = new Map<string, number>();
  for (const message of messages) {
    if (isTurnAnchor(message)) {
      const key = JSON.stringify(message);
      anchorCounts.set(key, (anchorCounts.get(key) ?? 0) + 1);
    }
  }
  const anchorOffsets = new Map<string, number>();
  let turn: Turn | undefined;
  let index = 0;
  return messages.map(message => {
    if (isTurnAnchor(message)) {
      const key = JSON.stringify(message);
      const turns = journalTurns.get(key);
      const count = anchorCounts.get(key);
      turn = count === 1 && turns?.length === 1 ? turns[0] : undefined;
      index = 0;
      if (turns && turns.length === count) {
        const offset = anchorOffsets.get(key) ?? 0;
        anchorOffsets.set(key, offset + 1);
        const owner = turns[offset]!.attempt;
        return withMessageOwner(projectUser(message, owner), owner);
      }
    } else if (turn) {
      // The event is stored just before Pi appends to JSONL. An interrupted or divergent
      // transcript may have only a common prefix; leave the unmatched suffix untouched.
      if (JSON.stringify(turn.messages[index++]) === JSON.stringify(message))
        return withMessageOwner(linkTools ? withToolIds(message, turn.attempt) : message, turn.attempt);
      turn = undefined;
    }
    return withMessageOwner(message);
  });
}
