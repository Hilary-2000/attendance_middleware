# Unattended boot setup (no PM2)

This replaces PM2 with native **Windows Task Scheduler**. After setup the
middleware starts on its own at boot with **no login required** and restarts
itself if it crashes.

## What gets created

| Task | What it does | Schedule |
|------|--------------|----------|
| `HikvisionDeviceSync` | person + face-photo sync loop (`Devicesync.js`) | 30 s after boot; watchdog every 10 min; auto-restart on crash |
| `HikvisionMiddleware` | posts attendance to the cloud (`index.js`) | every 5 min |
| `HikvisionUpdater` | `git pull` new code, then restart device-sync (`updater.js`) | daily 09:30 |

All three run as the **SYSTEM** account, so a reboot brings them back even if
nobody signs in.

---

## What you need to do

### Fresh PC — one line

Open PowerShell **as Administrator** and paste:

```powershell
[Net.ServicePointManager]::SecurityProtocol='Tls12'; irm https://raw.githubusercontent.com/Hilary-2000/attendance_middleware/main/setup/bootstrap.ps1 | iex
```

It installs Node + Git (via winget) if missing, clones the repo, runs
`npm install`, creates `.env`/`config.js` from the examples (opens `.env` in
Notepad — fill it in, save, close), then registers the three tasks. Then
**reboot** and run `.\setup\manage.ps1 status`.

### Existing PC that already runs PM2

Open PowerShell **as Administrator**:
```powershell
cd C:\Users\hp\Desktop\attendance_middleware
.\setup\install-native.ps1
```
It stops the old PM2 daemon, deletes the old `PM2 Resurrect` task, creates the
three tasks and starts them, prints status, and asks
**"Uninstall PM2 now? (y/N)"** — type `y`.

### Then: reboot and confirm
Restart the machine, wait ~2 minutes, then (a normal PowerShell is fine) `cd`
into the install folder and run:
```powershell
.\setup\manage.ps1 status
```
You want to see `HikvisionDeviceSync` with a running `node` process, and
`HikvisionMiddleware` with a recent `LastRunTime` and `LastResult 0x0`.

That's it — no further action needed.

---

## Day-to-day commands

```powershell
.\setup\manage.ps1 status                 # overview + recent log lines
.\setup\manage.ps1 logs device-sync       # live log (Ctrl+C to quit)
.\setup\manage.ps1 logs middleware
.\setup\manage.ps1 restart                # restart all (needs admin)
.\setup\manage.ps1 restart device-sync    # restart one  (needs admin)
.\setup\manage.ps1 stop                   # stop + disable everything (needs admin)
.\setup\manage.ps1 start                  # re-enable + start (needs admin)
```

Raw log files are in `logs\` as before
(`device-sync-out.log`, `device-sync-err.log`, `middleware-out.log`, …).

---

## If something looks wrong

- **A task shows `LastResult` other than `0x0`** → open the matching
  `logs\*-err.log` for the reason. The task will retry on its next tick.
- **device-sync not running** → `.\setup\manage.ps1 restart device-sync`
  (elevated), then check `logs\device-sync-err.log`.
- **Re-run the installer** any time — it is safe to run again.

## Rolling back to PM2

```powershell
.\setup\uninstall-native.ps1        # elevated
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
```

## Leftover PM2 files

`pm2-resurrect.bat`, `register-boot-task.ps1` and `ecosystem.config.cjs` are
still in the repo for reference / rollback. Delete them in a commit once
you're happy with the native setup.
