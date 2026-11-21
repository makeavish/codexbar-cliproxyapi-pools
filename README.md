# CLIProxyAPI Pools for CodexBar

See how much quota each Codex and Claude account has left, when it resets, and how long until then. Reset times use your Mac's time zone. The pool view averages the reported percentages, with equal weight per account.

When reported, account rows also show the Fable-only weekly limit, Claude's monthly spend cap, and Codex's monthly credit cap.

Set **Quota bars** to `remaining` (the default) or `used` in the plugin settings. Remaining mode shows the pace target in the label. Used mode follows CodexBar's **Show pace** setting for the bar marker.

Set **Reset times** to `countdown`, `clock`, or `both` (the default).

Set **Account labels** to `email` to show addresses from CLIProxyAPI. Leave it blank for numbered accounts, including when sharing your screen.

## Install

Run two local CLIProxyAPI instances with enabled OAuth accounts and the same management key. Tested on macOS with CodexBar 0.84.0. [CLIProxyAPI management API](https://help.router-for.me/management/api)

1. Download [`cliproxyapi-pools.js`](cliproxyapi-pools.js). Select it from **CodexBar → Settings → Plugins → Install…**.
2. Set **Codex hub URL** to `http://127.0.0.1:8317` and **Claude hub URL** to `http://127.0.0.1:8318`. Enter the shared **Management key**.
3. Click **Approve…** and type both origins when prompted. Enable **CLIProxyAPI Pools** and click **Refresh**.

To update, replace the script in `~/.config/codexbar/providers/`. Refresh the plugins directory, then refresh the plugin. [CodexBar plugin docs](https://github.com/steipete/CodexBar/blob/v0.84.0/docs/plugins.md#install-approve-run-and-delete)
