# Side chat

Side is a read-only assistant linked to a main agent. Questions do not interrupt main. Only an explicitly reviewed steering card sends an instruction to main.

## Workflow

- Follow the focused main session or pin a specific session. Drafts, provider/model choices, attached excerpts, and edited steering text are scoped by host and main session.
- Use **Ask Side** on a main response, tool detail, or diff selection. The composer shows the exact bounded excerpt before sending; opening a reference displays the captured text, not a potentially changed file.
- **Status** maintains one latest-status card. **Review changes** asks for evidence rather than accepting main's claims. **Draft steer** produces an editable proposal without sending it.
- Read-only provider enforcement remains authoritative. A provider/model can be selected before starting; start a new Side conversation to change it. New chat archives the old Side transcript and side agent without changing main.
- A delivery confirmation means the main input request was accepted, not that its instruction was implemented. Retries reuse a durable message identity. Unknown outcomes do not trigger a second instruction automatically.

## Context and continuity

Answers carry an epoch, sequence, fingerprint, capture time, and coverage indicator. In-place main tool updates can make an answer stale even without increasing its sequence. The UI shows that newer activity exists, not that an already-generated answer has learned it.

Context deltas include errors and todos as well as user, assistant, and tool events. A gap larger than the bounded tail fetches the missing timeline before selecting recent activity and important user/error/todo signals. The context remains bounded and explicitly marked abridged. Exact older details should be retrieved with the existing read-only activity tools.

Native same-provider forks retain recent Side exchanges and a bounded extractive continuity digest when refreshed after five minutes. Forks do not become new writers in main's workspace. Source labels such as `[Main #42]` can navigate to the corresponding main timeline cursor. Rewound epochs are rejected rather than opening a misleading source.

## Transport and persistence

The additive `sideChatV2` capability gates subscribe, reset, steer, and incremental `agent.side.changed` messages. Old get/send/stop fields and the legacy proposal string remain compatible. Changed messages contain message upserts, not a replacement transcript. Each conversation has its own revision sequence. Clients take an authoritative snapshot on initial subscription, revision gaps, conversation changes, reconnect, and foreground—even when the cached chat is idle.

The daemon owns generation independently of WebSocket lifetime. Subscriptions are reference-counted and released on teardown. Pending subscription requests use generation guards to prevent an older response or unsubscribe from overwriting a later session. New main activity updates freshness, without repeatedly sending all Side history.

Steering saves its stable message ID and exact approved text before invoking the existing durable agent request journal. The proposal and delivery receipt remain attached to their originating message across future questions and restarts. Retrying cannot change the already-attempted payload. Providers currently expose steering/interrupt semantics, not a reliable queued-next-turn operation, so the UI does not invent a queue option.

## Validation

Targeted checks cover context gaps, fork continuity, split proposal tags, read-only enforcement, proposal lifecycle, duplicate requests, revision recovery, idle reconnects, source selection, per-session drafts, mobile-width layout, and scroll retention. Browser tests use Chromium and real DOM layout. They do not substitute for installed-PWA testing on physical iOS or native-device keyboard testing.
