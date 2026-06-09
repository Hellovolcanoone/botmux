# Botmux

Botmux bridges chat conversations to AI coding command-line tools while keeping
the conversation anchored to the chat where the work started.

## Language

**Agent CLI**:
An AI coding command-line tool that botmux can run on behalf of a chat, such as
Claude Code, Codex, Gemini, Cursor, or OpenCode.
_Avoid_: agent cli, CLI bot

**Bot**:
A chat-visible identity configured to route messages into one selected
**Agent CLI**.
_Avoid_: agent, app

**Session**:
A continuing conversation between one chat anchor and one **Agent CLI**.
_Avoid_: thread, task

**Token Usage**:
Token counts reported by an **Agent CLI** or its persisted transcript for a
**Session**. Token In is the Agent CLI's native input-side total, including
cache read/create tokens when the CLI reports them; Token Out is the native
output-side total. Botmux does not estimate token counts from message text.
_Avoid_: token estimate, cost estimate

## Example Dialogue

Dev: "This Bot uses Codex as its Agent CLI."

Domain expert: "Good. When the user replies in the same Session, botmux should
route that reply back to the same Agent CLI conversation."

Dev: "Cursor did not expose Token Usage for this Session."

Domain expert: "Then botmux should say the Token Usage is unavailable, not guess
from the visible text."
