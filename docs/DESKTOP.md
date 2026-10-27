# Desktop app (macOS)

A thin Electron wrapper around the dashboard: it opens your mycodebox server in its own window, with a Dock icon,
remembered window size, and the usual Mac menu. It is not a second client; everything runs on the server.

The server address is not in the repository. You enter it on first run and it is stored on that Mac only
(`config.json` in the app's user-data folder).

## Get the .dmg

The app is built on a macOS runner, not on the Linux host.

- **From GitHub Actions:** run the workflow *Desktop app (mac)* (`.github/workflows/desktop-mac.yml`, manual
  `workflow_dispatch`), then download the `mycodebox-desktop-dmg` artifact from the finished run.
- **On a Mac yourself** (Node 20+):

  ```sh
  cd desktop
  npm install
  npm run dist      # builds build/icon.icns from public/icon-512.png, then an unsigned universal .dmg in desktop/dist/
  ```

The build is unsigned and not notarized. There is no signing identity or secret anywhere in the repo.

## Install

1. Open the `.dmg` and drag **mycodebox** to Applications.
2. First launch: macOS blocks unsigned apps. **Right-click the app, choose Open, then Open** in the dialog. (If that
   is refused: System Settings > Privacy & Security > "Open Anyway".) You need to do this once.
3. Enter the dashboard address, for example `https://<tailscale-host>:7443`, and press Connect. Your Mac must be on the tailnet.

## Change the address

Menu **mycodebox > Change server address…** (Cmd+,). If the server cannot be reached, the app offers Retry or Change address.

## Behaviour

- **Certificates:** a self-signed or tailnet certificate is accepted only for the stored server's origin (scheme, host, port). Any other host with a bad certificate is refused.
- **Links** to other sites open in the default browser; the window stays on the dashboard.
- **Reload:** Cmd+R; Cmd+Shift+R ignores the cache.
- **Notifications:** the notification permission is granted for the stored origin only. The dashboard's in-page
  notifications use the web Notification API, which Electron supports. Web Push (the phone path) does not work in
  Electron, so use the in-page "needs you" notifications here. Not yet verified on a real Mac.
- **Permissions:** only notifications, clipboard write, microphone/camera (voice) and fullscreen, and only for the stored origin.

## Code

`desktop/main.cjs` (window, menu, certificate and permission scoping), `desktop/lib/config.cjs` (address validation,
config file; tested by `test/desktop-config.test.js` without Electron), `desktop/pages/setup.html` (first-run page),
`desktop/scripts/make-icns.mjs` (icon). The server keeps its single runtime dependency; Electron lives only in `desktop/package.json`.
