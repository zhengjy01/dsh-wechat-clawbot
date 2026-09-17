/**
 * dsh-wechat-clawbot — bundle host entry.
 *
 * The browser half is declared by this package's `dsh.client` + `exports["./client"]`
 * (see package.json); the DSH host half lives in ./dsh-wechat-bot and is re-exported
 * here so the whole bridge installs as ONE package (`dsh plugin add`).
 *
 * Previously the host/client were separate `file:` sub-packages, which pnpm cannot
 * resolve when the bundle is installed from a tarball/git URL (it looks for the
 * sub-package beside the consumer profile, not beside the package). Keeping one
 * package removes that dependency without changing the plugin behavior.
 */
export * from './dsh-wechat-bot/index.js'
