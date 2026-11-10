// A chat as a plain list, the captain's way to read a day's chat on the Events calendar ("just like a list"): one
// message a line, when, who and what; his own lines "You", in the accent. No bubbles, no detail, nothing to edit, and a
// line opens nothing. What a message says is the reader's own (Conversation.tsx's MessageBody: attachments named by
// kind, never loaded). A line from a group, in a list that is not that group's, names the group before its words.

import type { TimelineMessage } from "../src/archive.ts";
import "./chatLines.css";
import { MessageBody } from "./Conversation.tsx";
import { timeText } from "./format.ts";

/** Who wrote a line, as the list says it: "You", or the first word of the sender's name ("Someone" for none). */
export function lineWho(message: Pick<TimelineMessage, "fromSelf" | "sender">): string {
  if (message.fromSelf) return "You";
  return message.sender?.trim().split(/\s+/)[0] || "Someone";
}

export function ChatLines({ messages, chat = null, label }: {
  messages: readonly TimelineMessage[];
  /** The chat the list is of, when it is one chat's: its lines name no group. */
  chat?: number | null;
  label: string;
}) {
  return (
    <ol className="chat-lines" aria-label={label}>
      {messages.map((message) => {
        const where = message.conversation.type === "group" && message.conversation.id !== chat ? message.conversation.title ?? "a group chat" : null;
        return (
          <li key={message.id} className={`chat-line${message.fromSelf ? " is-self" : ""}`}>
            <span className="chat-line__time">{timeText(message.sentAt)}</span>
            <span className="chat-line__who" title={message.fromSelf ? undefined : message.sender ?? undefined}>{lineWho(message)}</span>
            <span className="chat-line__text">
              {where && <span className="chat-line__where">in {where} · </span>}
              <MessageBody message={message} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}
