# Original admitted Job entries

A private strong Map retains every Job admitted through setIndexedJob until authorized index removal. Observer inventories come from those original admissions, independently of the mutable operational index. Replaced, deleted or foreign-key entries latch the original producer owner and retain replacement observations without rewriting the original admission ID.

Callbacks, result/error settlement, ACK, pin and fresh shutdown observation check index consistency. Uncertain ownership defers the exact original outcome and blocks ACK. Ordinary terminal deletion removes both indexes only while ownership is confirmed; normal cleanup continues to work.

The c5f36f7 review remains CHANGES_REQUIRED. Two initial failures were reproduced before repair. Seven successor controls additionally cover foreign-key movement, direct pin without any observer, original producer rejection and ordinary authorized deletion. All 877 cases across 46 explicitly selected isolated suites and typecheck passed. Fresh independent review and exact host checks remain required; no production, durable writer retirement or execution cancellation occurs.
