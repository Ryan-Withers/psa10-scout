# Setup, about 8 minutes

Everything runs in the cloud. Nothing on your PC, nothing to leave switched
on, no monthly cost.

- **GitHub Actions** does the scanning and sends the emails
- **Cloudflare** keeps time, because GitHub's own scheduler is unreliable
- **Claude Code on the web** lets you change it from any device afterwards

One script does the GitHub half. Step 7 adds the punctual clock. Works in
either PowerShell or Command Prompt, and says which is which where they
differ.

---

## 0. Fresh copy of the project

Your existing `C:\psa10-scout` still holds files from the abandoned
Cloudflare setup, and copying over the top does not remove them. Start clean.

Claude Desktop is a packaged app, so its files are not where `%APPDATA%`
normally points. Rather than hardcode a path that changes, this finds it.

**PowerShell** (prompt starts `PS`). Paste each block:

```
Remove-Item -Recurse -Force C:\psa10-scout -ErrorAction SilentlyContinue
```
```
$src = Get-ChildItem "$env:LOCALAPPDATA\Packages\Claude*\LocalCache\Roaming\Claude","$env:APPDATA\Claude" -Recurse -Filter setup-cloud.cmd -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
```
```
if ($src) { "Found: " + $src.DirectoryName } else { "NOT FOUND - tell Claude" }
```

That must print a path. If it does:

```
robocopy $src.DirectoryName C:\psa10-scout /E /XD node_modules .build .wrangler .claude
```
```
cd C:\psa10-scout
```

Robocopy prints a summary table. Zero failures is what you want. It reports a
non-zero exit code on success, which looks like an error and is not.

The `.claude` exclusion matters: that folder holds working files from this
chat, including keys pasted into it, and must never reach a public repo. The
project's `.gitignore` blocks it too, as a second line of defence.

## 1 to 6, in one script

**PowerShell:**

```
.\setup-cloud.cmd
```

**Command Prompt:**

```
setup-cloud.cmd
```

PowerShell will not run a script in the current folder without the `.\`
prefix. That is deliberate on Microsoft's part, so you cannot be tricked into
running something just because it shares a name with a real command.

That is the whole of it. The script installs GitHub's command line tool if
you do not have it, signs you in through the browser, creates the repo,
pushes the code, asks you for the five keys one at a time, mutes the first
run so it cannot email you, starts a full sweep, and waits for the result.

About three minutes of watching, most of it the scan itself.

It is safe to run again. Every step checks whether it has already been done,
so if something fails you fix that one thing and re-run.

When it finishes and you are happy with what it found:

```
gh variable delete ALERT_DRY_RUN
```

That turns emails on. Then do step 7 below, which is the only part that
cannot be scripted.

<details>
<summary>What it does, step by step, if you would rather do it by hand</summary>

1. `gh auth login --web` to sign in
2. `gh repo create psa10-scout --public --source=. --remote=origin --push`
3. `gh secret set NAME` five times, for `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`,
   `RESEND_API_KEY`, `ALERT_TO`, `ALERT_FROM`
4. `gh variable set ALERT_DRY_RUN` with value `1`
5. `gh workflow run scan.yml -f full=true`
6. `gh run watch --exit-status`, then `gh run download` for the report

</details>

## 7. Cloudflare becomes the clock

GitHub's own scheduler is the unreliable part: it queues cron jobs behind
everyone else's and drops them under load. So it is not driving this. A
25-line worker on Cloudflare fires at :00, :20 and :40 exactly, and pokes
GitHub through a different door that starts runs in seconds.

The scan still runs on GitHub. Cloudflare only keeps time, which is all its
free tier can do and all we need from it. GitHub's own schedule stays on at
four times a day as a backstop, so if the worker ever dies you drop to four
scans a day rather than none.

**Make the token.** On GitHub: your picture > **Settings** > **Developer
settings** > **Personal access tokens** > **Fine-grained tokens** > Generate
new token.

- Name: `scout-trigger`
- Repository access: **Only select repositories**, pick `psa10-scout`
- Permissions > Repository permissions > **Contents: Read and write**

Generate, copy it. It can do exactly one thing: poke this one repo.

**Put your username in the config.** Open `trigger\wrangler.toml` in Notepad,
change `YOUR-USERNAME/psa10-scout` to your actual username. Save.

**Deploy.**

```
cd C:\psa10-scout\trigger
```
```
npx wrangler deploy
```
```
npx wrangler secret put GH_TOKEN
```

Paste the token when it asks. Then push the config change. In PowerShell use
a semicolon between commands, in Command Prompt use `&&`:

```
cd C:\psa10-scout ; git add -A ; git commit -m "cloudflare trigger" ; git push
```

**Check it worked.** Wait for the next :00, :20 or :40, then look at the
Actions tab. A run should appear within seconds of the minute turning. If it
does not:

```
cd C:\psa10-scout\trigger ; npx wrangler tail
```

That streams the worker's log. Anything other than silence is an error worth
sending me.

---

## Things worth knowing

**It will not spam you.** Every card it emails is remembered. You only hear
about a card again if it improves, say a seller drops the price and it goes
from BUY to STRONG BUY.

**The price picture builds up over time.** Card values come from watching the
same cards get listed over and over. Day one it is working off a single
scan; after a fortnight it is much sharper. That history lives on a branch
called `state` and looks after itself.

**Run it by hand any time** from the Actions tab, Run workflow. Manual runs
sweep everything and attach the full report as a download. Scheduled runs do
not keep reports, the email is the product; a report is only attached when a
run fails and there is something to diagnose.

**Costs nothing, with no cap.** Public repos get unlimited free run time.

**It scans every 20 minutes, on the minute**, once step 7 is done.
Cloudflare keeps time and GitHub does the work. Before step 7 you are on
GitHub's own schedule, which is four times a day.

**Each run takes a quarter of the searches.** eBay allows 5,000 searches a
day and the full list costs 146, so running all of them every 20 minutes
would blow the limit twice over by dinner. Instead the broad catch-all
search runs every time, which is what actually spots a new listing, and the
35 detailed searches rotate across four runs. Full coverage every 80
minutes, at 64% of eBay's daily limit, leaving room for a dozen manual
sweeps on top. Every run prints its own usage, so you can see the headroom.

**Scheduled runs switch off after 60 days of a quiet repo.** GitHub emails
you first and there is a button to turn them back on.

**Delete the old Cloudflare worker.** In the Cloudflare dashboard there is a
`psa10-scout` worker from the abandoned first attempt, with old keys in it.
Delete it. The `psa10-scout-trigger` from step 7 is a different, tiny one and
should stay.

---

## Working on it from any device

Once the code is on GitHub you are no longer tied to your PC.

**Claude Code on the web**, at claude.ai/code, needs a Pro or Max plan. Connect
your GitHub account, pick `psa10-scout`, and describe what you want in plain
English. It works in an isolated cloud machine, pushes the change to a branch
and opens a pull request for you to approve. Sessions survive closing the
browser and you can watch them from the Claude mobile app. The repo carries a
`CLAUDE.md` explaining the project and its traps, so a fresh session starts
informed rather than guessing.

Useful things to ask it:

- "Add Emeka Egbuka and Luther Burden to my conviction list at 1.4"
- "This listing was misread, here is the title. Fix the parser and add a test"
- "Raise the PSA 9 bar, too many are getting through"

**Quick edits without Claude**: open the repo on github.com and press `.` for
a full editor in the browser, or use the GitHub mobile app. Good for adding a
card price to `data/my-values.json` from the couch.

Either way the change lands in the repo and the next scan picks it up. Nothing
to redeploy.

## Editing your two lists

`data/my-players.json` - players you rate, with a multiplier
`data/my-values.json` - cards you know the real price of

Both are read every run. After editing:

```
git add -A && git commit -m "my values" && git push
```
