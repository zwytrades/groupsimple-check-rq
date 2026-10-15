# groupsimple setup

The site is plain files on GitHub Pages. A small free Cloudflare Worker (`worker/worker.js`) connects it to your Discord bot.

How it works:
1. Someone fills in the form and uploads their server picture.
2. The Worker posts it in your private Discord channel with **Approve** and **Reject** buttons.
3. You click Approve. The Worker saves the group and its picture to your GitHub repo, and the site shows it about a minute later.
4. `/groups`, `/remove`, `/boost` and `/unboost` manage everything after that.

Do the steps in order. Keep a notepad open, you will collect a few values.

## 1. Put the site on GitHub Pages

1. Make a public repo and upload everything in this folder (keep the `worker` folder and the `pfp` folder will appear by itself later).
2. Settings, Pages, deploy from branch `main`, folder `/ (root)`.
3. Your site address is `https://YOURNAME.github.io/REPO/`. Note down the part before the repo name: `https://YOURNAME.github.io` (this is the **origin**).

## 2. Create the Discord bot

1. Go to https://discord.com/developers/applications and click New Application. Name it groupsimple.
2. General Information: copy **Application ID** and **Public Key**.
3. Bot page: click Reset Token and copy the **token**. Never share it.
4. OAuth2, URL Generator: tick `bot` and `applications.commands`. Under bot permissions tick View Channels, Send Messages, Attach Files, Embed Links. Open the generated link and add the bot to your server.
5. In Discord, create a private channel such as #listing-requests that only moderators can see. Give the bot access. Turn on Developer Mode (User Settings, Advanced), then right click the channel and Copy Channel ID. Right click your server name and Copy Server ID.

## 3. Create a GitHub token

GitHub, Settings, Developer settings, Personal access tokens, Fine-grained tokens, Generate new token.
Repository access: only your site repo. Permissions: Contents, Read and write. Copy the token.

## 4. Deploy the Worker

1. Go to https://dash.cloudflare.com, Workers and Pages, Create, Create Worker. Name it `groupsimple`, deploy, then Edit code.
2. Delete the sample code, paste in all of `worker/worker.js`, and Deploy.
3. Worker, Settings, Variables and Secrets. Add these (use Secret for the tokens and keys):

| Name | Value |
| --- | --- |
| DISCORD_PUBLIC_KEY | Public Key from step 2 |
| DISCORD_APP_ID | Application ID |
| DISCORD_BOT_TOKEN | bot token (secret) |
| DISCORD_CHANNEL_ID | mod channel id |
| DISCORD_GUILD_ID | server id |
| GITHUB_TOKEN | token from step 3 (secret) |
| GITHUB_REPO | YOURNAME/REPO |
| GITHUB_BRANCH | main |
| ALLOWED_ORIGIN | https://YOURNAME.github.io |
| SETUP_KEY | any long random text (secret) |

4. Copy your Worker address, like `https://groupsimple.YOURNAME.workers.dev`.

## 5. Connect Discord to the Worker

1. Developer portal, General Information, **Interactions Endpoint URL**: paste `https://groupsimple.YOURNAME.workers.dev/interactions` and save. Discord checks it right away. If it fails, one of the variables above is wrong.
2. Open `https://groupsimple.YOURNAME.workers.dev/register-commands?key=YOUR_SETUP_KEY` in a browser. It should say the commands are registered.

## 6. Connect the site to the Worker

In your repo, open `config.js`, click the pencil, and set `workerUrl` to your Worker address (no trailing slash). Commit. Wait a minute and refresh the site.

## Test it

1. On the site, list a test group with a picture.
2. A request appears in your mod channel. Click Approve.
3. After about a minute the group is in the directory.
4. Try `/groups`, then `/boost` on it. A boosted group is pinned to the top with a highlight until the time runs out.

## Everyday use

- **Approve or Reject** requests in the mod channel.
- **/boost group days** after you have been paid. Days add to any boost still running.
- **/unboost group** ends a boost early.
- **/remove group** deletes a group and its picture.
- **/groups** lists everything with its id.

Only people with the Manage Server permission can use the bot. To allow one more person, add their Discord user id to `ADMIN_USER_IDS`.

## Things to know

- GitHub Pages can take up to a couple of minutes to show a change.
- Only Discord and Telegram invite links are accepted, and every request is reviewed by a person.
- The Worker limits each visitor to a few requests every ten minutes. For stronger spam protection, add a Cloudflare rate limiting rule on `/submit`.
- The free Cloudflare and GitHub plans are enough for this.
