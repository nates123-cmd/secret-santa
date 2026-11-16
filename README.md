# Secret Santa

A small Elfster replacement where nobody, including the host, can see who drew whom.

- Each person claims their name on their own phone. The browser makes an ECDH P-256 key pair; only the public key goes to the server. The private key stays on the phone, with a backup sealed under a random recovery code.
- The draw runs in whoever's browser presses the button. Each giver's match is sealed to that giver's public key, and the full list is timelock-encrypted with drand (League of Entropy quicknet) to the round at `reveal_at`. The plaintext pairing is never stored.
- Supabase (suite project, `santa_*` tables) holds only ciphertext. Tables are closed to anon; all access is through `santa_*` security-definer RPCs keyed by the invite code.

## Open groups (host knows the list)

A group with `mode = 'open'` is for a host who isn't playing. Nothing is sealed: the pairing sits in `santa_open_draws`, each person logs in (tap name, email code) and `santa_my_match` hands them only their own match, from any device. The host link `#g=<invite_code>&host=<host_code>` shows who has logged in and the full list, draws (or redraws) names, and can reset a name's email. Everyone sees the full list once `reveal_at` passes. Sealed groups are unaffected.

Invite link: `https://nates123-cmd.github.io/secret-santa/#g=<invite_code>`

`vendor/tlock.js` is tlock-js 0.9.0 bundled with esbuild (see `build/`).

Limits: the person pressing Draw runs the code, so a modified build could log pairs. A lost phone plus a lost recovery code means that person's match can't be opened until the Christmas reveal.
