# Agent Activity Events

The optional event journal records what agents and tools accomplished without
polluting semantic memory.

Use events for completed tool calls, deployments, test outcomes, incidents,
handoffs, and session milestones. Store a short factual summary plus optional
`agent_id`, `session_id`, `tool_name`, `source_system`, `external_id`, structured
payload, and `occurred_at`.

Do not store chain-of-thought, hidden reasoning, raw chat logs, credentials,
customer secrets, or large command output. The API applies the same credential
pattern guard used by ordinary memory.

`(namespace, source_system, external_id)` makes retries idempotent. Events are not
embedded by default. `context` can include the five most recent authorized events
when `include_events:true`; durable conclusions should still be promoted to normal
memory explicitly.
