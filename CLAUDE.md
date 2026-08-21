# CLAUDE.md

## Project Overview

Image proxy service for Mobelaris that caches images on Cloudflare R2 (S3-compatible) from Cloudinary and ImageKit CDNs. Built with Hono.

## Commands

```bash
npm run start    # Start production server
npm run dev      # Start with --watch for development

# Mirror every Cloudinary original into R2 (safe to re-run; skips what exists).
# Run it inside a deployed container so the pull uses the server's bandwidth:
#   docker exec -e CLOUDINARY_API_KEY=... -e CLOUDINARY_API_SECRET=... <container> \
#     node /app/scripts/mirror-cloudinary.js --concurrency 6
node scripts/mirror-cloudinary.js [--limit N] [--prefix media/catalog] [--concurrency 8]

# Confirm local renders match Cloudinary's, reading both sides from R2
node scripts/check-transform-parity.js [--prefix <key prefix>] [--samples 20]
```

## Architecture

### Core: `server.js`

Single Hono server with one route (`/api/images/*`) that:

1. **R2 Cache Check**: HeadObject to see if image exists in the `imageproxy-cache` bucket
2. **Cache Hit**: Stream GetObject response directly to client
3. **Local Render**: On a miss, look for the mirrored *original* in R2 and apply the
   transform locally with sharp
4. **Cache Miss**: Only if there is no mirrored original, render from Cloudinary
   (ImageKit fallback for `uploads/` paths), upload to R2 (background), serve buffer
5. **Transformation Mapping**: Converts between CDN-specific syntax (Cloudinary `w_1440` ↔ ImageKit `w-1440`)

### Request Flow

```
/api/images/[path] → Check R2 → Hit? Stream from R2
                              → Miss? → Mirrored original in R2? → sharp → Upload R2 → Serve
                                      → Otherwise render from Cloudinary → Upload R2 → Serve
```

### Local transforms (why Cloudinary is now the last resort)

The Cloudinary account is over its Free-plan credit limit (111.96/99 on 2026-08-21) and
will be cut off, so a cache miss must not depend on it. `scripts/mirror-cloudinary.js`
copies every Cloudinary original into the same bucket at
`dfgbpib38/image/upload/<public_id>.<format>` — the exact key the proxy looks up for an
untransformed asset — and `transformLocally()` renders derivatives from it.

Only `e_trim`, `w_N`, `c_limit` and `f_auto` render locally; they are the entire
vocabulary of the 136 transform combinations the cache has ever held. Anything else
falls through to Cloudinary on purpose. Silently ignoring an unrecognised transform
would cache a wrong render under a correct URL, which is how both previous
wrong-bytes incidents happened.

`withoutEnlargement` is always set (that is exactly what `c_limit` means), so a local
render can never upscale — same guarantee as the note below about never deriving a
size from an existing cache entry. Local rendering derives only from the full
original, never from a derived entry.

`e_trim` runs as its own sharp pass before the resize, for the same reason
`buildCloudinaryUrl` gives it its own transformation component: trim → resize is what
the request asked for, and the reverse returns far less than the requested width.
Verify parity with `scripts/check-transform-parity.js`, which compares a local render
against the Cloudinary-rendered copy already in R2 (and so costs no Cloudinary credits).

Every cache miss renders from Cloudinary, which always works from the full
original. The proxy must never derive a size from an existing cache entry — that
previously upscaled thumbnails into larger widths and the result was cached
`immutable` for a year, then reused as the source for other widths.

### Cloudinary transform ordering

`e_trim` must be its own leading transformation component (`e_trim/w_600`, not
`e_trim,w_600`). Cloudinary applies everything inside one component together and
resizes *before* trimming, so the comma form crops the whitespace away after the
resize and returns far less than the requested width. Conversely the remaining
transforms must stay comma-joined — splitting `c_limit` from `w_856` drops the
limit and lets Cloudinary upscale past the original.

### Environment Variables (required)

```
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<access-key-id>
R2_SECRET_ACCESS_KEY=<secret-access-key>
R2_BUCKET=imageproxy-cache
PORT=3000
```

`scripts/mirror-cloudinary.js` additionally needs `CLOUDINARY_API_KEY` and
`CLOUDINARY_API_SECRET` (and optionally `CLOUDINARY_CLOUD_NAME`, default `dfgbpib38`).
Pass them as env vars — never commit them. Note that `scripts/sync-swatchs.js` and
`scripts/sync-uploads.js` predate this rule: they have the Cloudinary key and secret
hardcoded, and still write to the retired MinIO bucket rather than R2.
