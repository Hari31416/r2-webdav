# Cloudflare R2 WebDAV and OPDS Server

A serverless WebDAV server and e-reader OPDS catalog running on Cloudflare Workers backed by Cloudflare R2 object storage.

## Features

- Full WebDAV Class 1 and Class 2 protocol support (including `LOCK`/`UNLOCK`).
- Mobile-friendly responsive web file manager with drag-and-drop file upload, download, delete, and folder creation.
- Native OPDS 1.2 catalog feed (`/opds`) tailored for e-ink readers like KOReader on Kobo and Kindle.
- In-memory embedded metadata extraction for EPUB and MOBI/AZW3 files (title, author, description).
- Zero egress bandwidth costs via Cloudflare R2.
- HTTP Basic Authentication.

## Setup and Deployment

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Configure R2 Bucket

Create an R2 bucket in your Cloudflare account:

```bash
wrangler r2 bucket create webdav
```

Ensure `wrangler.toml` references your bucket:

```toml
compatibility_date = "2023-10-16"
main = "src/index.ts"
name = "r2-webdav"
compatibility_flags = ["nodejs_compat"]

[[r2_buckets]]
binding = "bucket"
bucket_name = "webdav"
```

### 3. Deploy and Set Secrets

Deploy the Worker to Cloudflare:

```bash
wrangler deploy
```

Set your HTTP Basic Authentication credentials:

```bash
wrangler secret put USERNAME
wrangler secret put PASSWORD
```

## Connecting Clients

### macOS Finder

1. In Finder, press `Cmd + K` (Connect to Server).
2. Enter `https://<worker-name>.<subdomain>.workers.dev`.
3. Choose **Registered User** and enter your credentials.

To avoid macOS metadata file conflicts (`._` files and `.DS_Store`) on network drives, run:

```bash
defaults write com.apple.desktopservices DSDontWriteNetworkStores -bool true
killall Finder
```

### KOReader (Kobo / Kindle / Android)

1. Open KOReader and select **Search** > **OPDS Catalog**.
2. Tap **Add new catalog**.
3. Set the URL to: `https://<worker-name>.<subdomain>.workers.dev/opds`.
4. Enter your configured username and password.
5. Browse books by embedded title and author, and tap to download directly to your device.
