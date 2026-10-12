# Bot assets

`paynet-qr.png` — the static Paynet QR code the bot sends after `/subscribe`.

- Put the file here, named exactly `paynet-qr.png` (PNG).
- It is bundled into `telegram-bot-webhook` at deploy time
  (`static_files` in `supabase/config.toml`) and never served from a public URL.
- Redeploy `telegram-bot-webhook` after replacing it.
- Without it, `/subscribe` tells the owner the QR is unavailable and logs
  `[subscription] could not read the Paynet QR image`.
