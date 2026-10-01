# Captured unsubscribe receiver

McpEventsController invokes the original captured unsubscribe with the controller receiver under both ordinary and nonforcing close. The nonforcing synchronous fence stays registered before invocation and preserves its strict return/error ownership behavior.

The previous 6e7f9fd independent review remains CHANGES_REQUIRED for an ordinary-function compatibility issue. Its current native registry arrow ignored the receiver, so this repair does not imply a deployed native failure. The actual constructor regression failed before the one-line repair and passed afterward; 279 isolated fixture cases and typecheck passed. Exact compiled host checks and fresh independent review remain separate requirements.
