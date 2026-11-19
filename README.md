# Stretch + Lift

Offline iPhone web app for tracking stretching (stretches grouped into workouts, daily checklist) and gym sessions (final-set reps × kg),
with a motivational calendar, streaks, progress charts, notes, Calendar-based reminders and JSON backup.

All data is stored on the phone (localStorage). Use **More → Export backup** now and then.

## Files
- `index.html`, `styles.css`, `app.js` — the app (no dependencies, no build step)
- `sw.js` — offline cache. **Bump `VERSION` whenever you change any file** so installed copies update.
- `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png` — home-screen install (icons rendered from `icon.svg`)

## Install
Host the folder on any HTTPS static host (Netlify Drop, GitHub Pages, Cloudflare Pages),
open the URL in Safari on the iPhone → Share → Add to Home Screen.

## Rules
- Each stretch belongs to a workout. A stretch day counts when every stretch in at least one workout is ticked.
  (Days logged before v2 keep their old 50%-rule result unless edited.)
- Week (Mon–Sun): **S** green if every day counted, **G** green if ≥ 1 gym session.
- Days before your first use don't count against you.
