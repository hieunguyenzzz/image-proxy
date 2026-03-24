# CLAUDE.md

## Project Overview

Image proxy service for Mobelaris that caches images on MinIO (S3-compatible) from Cloudinary and ImageKit CDNs. Built with Hono.

## Commands

```bash
npm run start    # Start production server
npm run dev      # Start with --watch for development
```

## Architecture

### Core: `server.js`

Single Hono server with one route (`/api/images/*`) that:

1. **MinIO Cache Check**: HeadObject to see if image exists in `imageproxy-cache` bucket
2. **Cache Hit**: Stream GetObject response directly to client
3. **Cache Miss**: Download from Cloudinary/ImageKit, upload to MinIO (background), serve buffer
4. **Transformation Mapping**: Converts between CDN-specific syntax (Cloudinary `w_1440` ↔ ImageKit `w-1440`)

### Request Flow

```
/api/images/[path] → Check MinIO → Hit? Stream from MinIO
                                  → Miss? Download CDN → Upload MinIO → Serve buffer
```

### Environment Variables (required)

```
MINIO_ENDPOINT=https://minio-api.hieunguyen.dev
MINIO_ACCESS_KEY=<access-key>
MINIO_SECRET_KEY=<secret-key>
MINIO_BUCKET=imageproxy-cache
PORT=3000
```
