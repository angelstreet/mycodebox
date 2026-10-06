# Native TLS certificates

[Documentation index](../docs/README.md) · [Installation](../docs/INSTALL.md)

Prefer the loopback + Tailscale Serve setup in INSTALL for managed HTTPS. This page is for the alternative Node TLS listener.

`server.js` starts HTTPS only when both files exist:

- `certs/key.pem`: private key, mode 0600, readable by the service user.
- `certs/cert.pem`: matching certificate/chain, mode 0644.

Override with absolute `TLS_KEY` and `TLS_CERT` paths. `TLS_PORT` defaults to 7443 (443 if `PORT=443`). HTTPS uses the same `HOST` as HTTP and does not disable the HTTP listener. Both must remain private.
Only the two exact PEM paths above are currently ignored by Git; store other key filenames outside the checkout.

## Trusted certificate for the Tailscale DNS name

Enable MagicDNS and HTTPS certificates using [Tailscale's HTTPS instructions](https://tailscale.com/docs/how-to/set-up-https-certificates). Use the node's full `*.ts.net` name, not its IP or short name. Certificate names appear in public certificate-transparency logs.

From the checkout, replace the placeholder locally:

```bash
sudo tailscale cert --cert-file=certs/cert.pem --key-file=certs/key.pem '<machine>.<tailnet>.ts.net'
```

Set key ownership to the service user and mode 0600 before starting/restarting. Verify the certificate is readable by that user without printing the key. Open `https://<machine>.<tailnet>.ts.net:7443/` with a matching hostname and no browser warning.
Certificates written by `tailscale cert` need renewal: arrange reissuance before expiry and a guarded service restart to load renewed files. Serve manages renewal when using the recommended proxy mode.
Use [INSTALL's restart procedure](../docs/INSTALL.md#update-and-uninstall); never restart during a deploy.

## Self-signed certificates

A self-signed certificate is only suitable when every client explicitly trusts the issuing certificate/CA and the hostname matches. Clicking through a warning is not reliable support for service workers, PWA installation, push or microphone access. Prefer trusted HTTPS; do not tell users to disable certificate checks or open public ports to obtain a certificate.
Never commit keys or copy real machine names or addresses into this page.
