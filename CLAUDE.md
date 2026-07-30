# CLAUDE.md

## Project Overview

Image proxy service for Mobelaris that caches images on Cloudflare R2 (S3-compatible) from Cloudinary and ImageKit CDNs. Built with Hono.

## Commands

```bash
npm run start    # Start production server
npm run dev      # Start with --watch for development
```

## Architecture

### Core: `server.js`

Single Hono server with one route (`/api/images/*`) that:

1. **R2 Cache Check**: HeadObject to see if image exists in the `imageproxy-cache` bucket
2. **Cache Hit**: Stream GetObject response directly to client
3. **Cache Miss**: Render from Cloudinary (ImageKit fallback for `uploads/` paths), upload to R2 (background), serve buffer
4. **Transformation Mapping**: Converts between CDN-specific syntax (Cloudinary `w_1440` ↔ ImageKit `w-1440`)

### Request Flow

```
/api/images/[path] → Check R2 → Hit? Stream from R2
                              → Miss? Render from Cloudinary → Upload R2 → Serve buffer
```

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
