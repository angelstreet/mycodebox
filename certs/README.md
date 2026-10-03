# TLS certificates

Drop two files here so the server picks them up automatically:

- `key.pem`  — private key (mode 600, git-ignored)
- `cert.pem` — certificate (mode 644)

## Generate a self-signed cert (good enough on a Tailscale tailnet)

```bash
cd ~/ghosty-sessions
openssl req -x509 -newkey rsa:2048 \
  -keyout certs/key.pem -out certs/cert.pem -days 3650 -nodes \
  -subj "/CN=codebox" \
  -addext "subjectAltName=IP:<tailscale-ip>,DNS:codebox,DNS:codebox.<your-tailnet>.ts.net,DNS:localhost"
chmod 600 certs/key.pem
sudo systemctl restart ghosty-sessions
```

You'll see the server now listens on **HTTPS** too — `:7443` by default. Open
`https://<your-tailnet-ip>:7443/` on your phone, accept the cert once, and the
PWA install option unlocks.

## For a real cert (no warning on the phone)

Paid Tailscale plans can issue one for free:

```bash
sudo tailscale cert <host>.<tailnet>.ts.net
sudo cp <host>.<tailnet>.ts.net.crt certs/cert.pem
sudo cp <host>.<tailnet>.ts.net.key certs/key.pem
sudo systemctl restart ghosty-sessions
```

Or point any public hostname at your tailnet IP and use Let's Encrypt
(`certbot`) — but that requires inbound 80/443, which a tailnet usually can't
do.