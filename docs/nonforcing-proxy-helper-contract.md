# Owned proxy rejection and cleanup

Error responses use the same synchronous request fence and original receiver as successful proxy continuations. A callback that pins shutdown stops subsequent headers, body writes, and delegation.

Unavailable POST classification owns its original request-id capture, stream edges, timer, and counter before listeners are installed. Late chunks are retained by identity after pin. A cleanup exception preserves the original capture and accounting and prevents response completion or dispatch; only a completed ordinary response retires this owner.

The b175318 independent review remains CHANGES_REQUIRED. The successor adds its four reproductions plus normal 413, request-id 41, and raw cleanup exception controls. Local isolated validation passed 77 cases; exact compiled host proofs and fresh independent review remain required. No production, writer evidence, or CLI lease authority changes.
