# Security Specification: HACK THE SYSTEM Reading Escape Room

## 1. Data Invariants
1. Answer keys, sheet codes, hint texts, and admin PINs MUST NEVER be stored in plaintext in publicly readable Firestore collections. They are encrypted with AES-256-GCM on the Next.js server (`secrets/config` and `group_private/{groupId}`).
2. `server_gate/main` MUST never be readable by clients (`allow read: if false;`), and updates require matching `gateToken` and rotating `nonce`.
3. Every mutation to `sessions`, `groups`, `logs`, `requests`, `secrets`, and `group_private` MUST verify via `getAfter()` that `server_gate/main` rotated its `nonce` in the same atomic commit batch, blocking forged direct client writes.
4. Every document ID path parameter (`sessionId`, `groupId`, `requestId`, `logId`, `secretId`, `gateId`) MUST match `^[a-zA-Z0-9_\-]+$` and be `<= 128` characters.
5. Every string and array field MUST enforce strict type and `.size()` bounds, plus exact `hasAll` / `hasOnly` field allowlists to prevent shadow fields and resource poisoning.
6. Point balances on `Group` are non-negative (`points >= 0`) and `currentSheet` is bounded (`1..6`), `completedSheets` is bounded (`0..5`).

## 2. Adversarial Payloads ("Dirty Dozen")
1. **Shadow Field Injection on Group**: Creating a group with extra field `isAdmin: true` or `bypassCooldown: true` -> MUST be rejected by `keys().hasOnly(...)`.
2. **Direct Client Score Tampering**: Client calling `updateDoc` on `groups/{groupId}` setting `points: 9999` without rotating `server_gate/main.nonce` -> MUST be rejected by `gateRotated(sessionId)`.
3. **Gate Token Extraction**: Client calling `getDoc` on `sessions/{sessionId}/server_gate/main` -> MUST return `PERMISSION_DENIED` (`allow read: if false;`).
4. **Gate Token Forgery**: Client updating `server_gate/main` with a guessed `gateToken` -> MUST be rejected by `incoming().gateToken == existing().gateToken`.
5. **Resource Poisoning via Oversized ID**: Accessing `/sessions/<2KB-string>` -> MUST be rejected by `isValidId(sessionId)`.
6. **Oversized Team Name**: Creating group with 500-char `teamName` -> MUST be rejected by `data.teamName.size() <= 50`.
7. **Empty or Overstuffed Members Array**: Group with `members: []` or 20 members -> MUST be rejected by `data.members.size() >= 2 && data.members.size() <= 5`.
8. **Negative Score Injection**: Setting `points: -10` on `Group` -> MUST be rejected by `data.points >= 0`.
9. **Sheet Jumping**: Setting `currentSheet: 99` or `completedSheets: 10` -> MUST be rejected by range checks (`1..6` and `0..5`).
10. **Invalid Session Status**: Setting `status: "hacked"` on `Session` -> MUST be rejected by enum check `in ['waiting', 'running', 'paused', 'ended']`.
11. **Wildcard Unlisted Collection Access**: Reading/writing `/arbitrary/doc` -> MUST be rejected by global catch-all deny rule.
12. **Reading Encrypted Secrets Without Valid ID**: Accessing `/sessions/invalid$id/secrets/config` -> MUST be rejected by `isValidId()`.
