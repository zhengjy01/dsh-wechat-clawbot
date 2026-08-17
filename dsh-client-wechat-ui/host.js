/**
 * dsh-client-wechat-ui — host half (no-op).
 *
 * This package's host side exists only so the loader can mount the row; all
 * behavior lives in the browser bundle (`./client`), which the client-modules
 * node half serves as `/plugins/dsh-client-wechat-ui/client.js` and the
 * floating ball renders inside the GUI.
 */
export const name = 'dsh-client-wechat-ui'
export function apply() {
  /* browser-only plugin; nothing to mount on the host */
}
