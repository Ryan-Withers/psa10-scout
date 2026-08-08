/**
 * The starting pistol.
 *
 * GitHub's own scheduler queues cron jobs behind everyone else's and starts
 * them minutes late, sometimes not at all. Cloudflare's cron fires on time,
 * but its free plan allows 10ms of CPU per run, which cannot run the scan.
 * It can, however, fire one webhook, and a run GitHub receives by webhook
 * starts in seconds rather than joining the scheduled queue.
 *
 * So the scan lives on GitHub and the clock lives here. Each piece does the
 * one thing its free tier is actually good at.
 *
 * Needs two settings:
 *   REPO      var,    "your-username/psa10-scout"
 *   GH_TOKEN  secret, fine-grained PAT, this repo only, Contents write
 */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      fetch(`https://api.github.com/repos/${env.REPO}/dispatches`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'psa10-scout-trigger',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ event_type: 'scan' }),
      }).then(async (r) => {
        // 204 is success. Anything else is worth a line in the tail log,
        // because the failure mode here is silence.
        if (r.status !== 204) console.error(`dispatch ${r.status}: ${(await r.text()).slice(0, 200)}`);
      })
    );
  },
};
