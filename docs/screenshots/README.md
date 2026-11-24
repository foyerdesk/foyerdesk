# Screenshots

Taken from the real screens (`packages/ui`) in a real browser. The Worker is replaced by the same small stand-in the tests use, so **the names, topics and messages are demo data**, not a live Chatwoot.

Regenerate: `npm install && npm run setup:browser && npm run media -w packages/ui` (needs `ffmpeg` for the GIF). The animation shows: open a topic, write a reply, receive the team's answer live, mark as resolved, back to the list.

| File | Shows |
|---|---|
| `01-sign-in.png` | Signed-out visitor |
| `02-topics.png` | Topic list with status badges, side panel, unread marker |
| `03-conversation.png` | One topic with its own scroll and reply box |
| `04-new-topic.png` | New topic form |
| `05-dark.png` | Dark theme |
| `06-mobile-list.png`, `07-mobile-conversation.png` | Phone width |
| `demo.gif` | Main scenario |

There is no administrator screen: operators work in Chatwoot.
