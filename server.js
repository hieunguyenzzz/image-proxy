const { Hono } = require('hono');
const { serve } = require('@hono/node-server');
const { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { Readable } = require('stream');
const http = require('http');
const https = require('https');

const app = new Hono();

// Outbound CDN fetches must be bounded too — a hung upstream otherwise
// keeps the request open until Cloudflare gives up (524).
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '20000', 10);

const s3 = new S3Client({
    endpoint: process.env.R2_ENDPOINT,
    region: 'auto',
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
    // Bound every cache request and lift the 50-socket default. Without timeouts a
    // single hung connection holds its socket forever; the pool fills and all
    // subsequent S3 calls queue indefinitely (the exhaustion outage on 2026-06-17,
    // ~71k requests enqueued at capacity=50). Timeouts let stuck sockets recycle.
    requestHandler: new NodeHttpHandler({
        connectionTimeout: parseInt(process.env.S3_CONNECTION_TIMEOUT_MS || '5000', 10),
        requestTimeout: parseInt(process.env.S3_REQUEST_TIMEOUT_MS || '30000', 10),
        httpAgent: new http.Agent({ keepAlive: true, maxSockets: 256 }),
        httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 256 }),
    }),
});

const BUCKET = process.env.R2_BUCKET || 'imageproxy-cache';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const CONTENT_PATHS = new Set(['media', 'uploads', 'wp-content', 'swatchs']);

const getContentType = (name) => {
    if (name.includes('.webp')) return 'image/webp';
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.gif')) return 'image/gif';
    if (name.endsWith('.svg')) return 'image/svg+xml';
    return 'image/jpeg';
};

const sanitizePath = (segments) => {
    return segments
        .filter(s => s !== '..' && s !== '.' && !s.includes('..') && s.length > 0)
        .map(s => s.replace(/[<>:"|?*]/g, ''));
};

// Cloudinary-native assets have no media/ or swatchs/ marker — they look like
// `v1686913543/jetszl8qr9eytk9fmoke.png` (or just the public ID). Without these
// checks the version and the filename get swallowed into the transform list and
// the content path comes out empty, producing a URL Cloudinary rejects with 400.
const isVersion = (s) => /^v\d+$/.test(s);
// Comma-joined segments are transform groups, never filenames — guard against a
// group like `e_trim,w_64,x.png` being mistaken for the start of the asset path.
const isAssetFile = (s) => !s.includes(',') && /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(s);

// Parse path into { base, transforms[], contentPath }
// Input: ['dfgbpib38', 'image', 'upload', 'e_trim', 'w_200', 'f_auto', 'media', 'catalog', ...]
// Output: { base: 'dfgbpib38/image/upload', transforms: ['e_trim', 'w_200', 'f_auto'], contentPath: 'media/catalog/...' }
const parsePath = (segments) => {
    const uploadIdx = segments.indexOf('upload');
    if (uploadIdx === -1) return null;

    const base = segments.slice(0, uploadIdx + 1).join('/');
    const rest = segments.slice(uploadIdx + 1);

    const transforms = [];
    let contentStart = 0;

    for (let i = 0; i < rest.length; i++) {
        if (CONTENT_PATHS.has(rest[i]) || isVersion(rest[i]) || isAssetFile(rest[i])) {
            contentStart = i;
            break;
        }
        // Split comma-separated transforms into individual ones
        rest[i].split(',').forEach(t => { if (t) transforms.push(t); });
        contentStart = i + 1;
    }

    const contentPath = rest.slice(contentStart).join('/');
    return { base, transforms, contentPath };
};

// Generate all key variants to check in the cache bucket
const generateKeys = (parsed, rawSegments) => {
    if (!parsed) return [rawSegments.join('/')];

    const { base, transforms, contentPath } = parsed;
    const keys = new Set();

    // 1. Comma-joined transforms
    if (transforms.length > 0) {
        keys.add(base + '/' + transforms.join(',') + '/' + contentPath);
    }

    // 2. Separate transform segments
    if (transforms.length > 0) {
        keys.add(base + '/' + transforms.join('/') + '/' + contentPath);
    }

    // 3. Raw path as-is
    keys.add(rawSegments.join('/'));

    // 4. Just content path (no transforms — for swatchs etc)
    if (transforms.length === 0) {
        keys.add(base + '/' + contentPath);
    }

    return [...keys];
};

const objectExists = async (key) => {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
            return true;
        } catch (e) {
            // NotFound means object doesn't exist — no retry
            if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
            // Network error — retry once
            if (attempt === 0) continue;
            return false;
        }
    }
    return false;
};

const getObject = async (key) => {
    const { Body, ContentType } = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return { body: Body, contentType: ContentType };
};

const putObject = async (key, buffer, contentType) => {
    await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: CACHE_CONTROL,
    }));
};

const downloadImage = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
};

const serveFromCache = async (key, contentType) => {
    const { body } = await getObject(key);
    const nodeStream = body instanceof Readable ? body : Readable.fromWeb(body);
    return new Response(nodeStream, {
        headers: { 'Content-Type': contentType, 'Cache-Control': CACHE_CONTROL },
    });
};

// Build the Cloudinary delivery URL.
//
// Cloudinary applies every operation inside a single transformation component
// together, resizing BEFORE trimming. So `e_trim,w_1024` scales to 1024px and
// *then* crops the whitespace away, returning far less than the requested width
// (measured: 445px for ch25-black-natural-2, 262px for `e_trim,w_600`). Giving
// e_trim its own leading component forces trim -> resize, which is the order the
// incoming request path already asked for, and returns the true width.
//
// The remaining transforms must stay comma-joined in one component: splitting
// `c_limit` away from `w_856` drops the limit and lets Cloudinary upscale past
// the original (measured 856px vs the correct 834px).
const buildCloudinaryUrl = (parsed, rawSegments) => {
    if (!parsed) return 'https://res.cloudinary.com/' + rawSegments.join('/');

    const { base, transforms, contentPath } = parsed;
    const rest = transforms.filter(t => t !== 'e_trim');

    const components = [];
    if (transforms.includes('e_trim')) components.push('e_trim');
    if (rest.length > 0) components.push(rest.join(','));

    return 'https://res.cloudinary.com/' + [base, ...components, contentPath].join('/');
};

// Health check
app.get('/', (c) => c.text('imageproxy ok'));

// Image proxy route
app.get('/api/images/*', async (c) => {
    // Strip srcset junk (e.g. "image.png 640w, https/...") — take only the first URL path
    let rawPath = decodeURIComponent(c.req.path).replace('/api/images/', '');
    rawPath = rawPath.split(/\s+\d+w/)[0].trim();
    let imageFile = rawPath.split('/');
    imageFile = imageFile.filter(item => item !== 'mobelaris');
    imageFile = sanitizePath(imageFile);

    if (imageFile.length === 0) return c.text('Invalid path', 400);

    const name = imageFile[imageFile.length - 1];
    if (name === 'no_selection' || name === 'undefined') return c.text('Invalid image', 400);

    const contentType = getContentType(name);
    const parsed = parsePath(imageFile);
    const keys = generateKeys(parsed, imageFile);

    // Check R2 cache — try all key variants
    for (const key of keys) {
        try {
            if (await objectExists(key)) {
                return await serveFromCache(key, contentType);
            }
        } catch {}
    }

    // Cache miss — render from Cloudinary. Never derive a new size from an
    // already-derived cache entry: doing that upscaled thumbnails (a w_600 built
    // from a 200px copy) and the result was cached immutable for a year, then
    // reused as the source for other widths. Cloudinary always renders from the
    // full original, so every miss is a clean render.
    const primaryKey = keys[0];
    const imagekitAttributes = [];
    if (parsed) {
        for (const t of parsed.transforms) {
            if (t === 'e_trim') imagekitAttributes.push('t-true');
            const wm = t.match(/^w_(\d+)$/);
            if (wm) imagekitAttributes.push('w-' + wm[1]);
        }
    }

    const url = buildCloudinaryUrl(parsed, imageFile);
    let imageBuffer = null;

    // Try Cloudinary first, then ImageKit for uploads/ paths
    try {
        console.log('downloading ' + url);
        imageBuffer = await downloadImage(url);
    } catch (err) {
        // If Cloudinary fails and path starts with uploads/, try ImageKit
        if (parsed && parsed.contentPath.startsWith('uploads/')) {
            try {
                const uploadParts = parsed.contentPath.split('/');
                const alternativeUrl = 'https://ik.imagekit.io/tg3wenekj/' + [uploadParts[0], uploadParts[1]].join('/') + '?tr=' + imagekitAttributes.join(',');
                console.log('fallback to imagekit: ' + alternativeUrl);
                imageBuffer = await downloadImage(alternativeUrl);
            } catch (err2) {
                console.log('can not download ' + url);
            }
        } else {
            console.log('can not download ' + url);
        }
    }

    // Keep failures out of the CDN for more than a moment. This response carried no
    // Cache-Control, so the zone's default browser TTL (8 days) applied and a single
    // transient Cloudinary blip pinned a working image to a 404 for over a week.
    // Short TTL rather than no-store: genuinely absent assets (missing swatches) are
    // requested constantly, and no-store would send every one of those to Cloudinary.
    if (!imageBuffer) {
        return c.text('Image not found', 404, { 'Cache-Control': 'public, max-age=60' });
    }

    // Cache in R2 using the comma-joined key (canonical format)
    putObject(primaryKey, imageBuffer, contentType).catch(err => {
        console.log('R2 upload error for ' + primaryKey, err.message);
    });

    return c.body(imageBuffer, 200, {
        'Content-Type': contentType,
        'Cache-Control': CACHE_CONTROL,
    });
});

// Warm up S3 connection before accepting requests
const warmup = async () => {
    try {
        await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: '__warmup__' }));
    } catch {}
    console.log('S3 connection ready');
};

const port = parseInt(process.env.PORT || '3000');
warmup().then(() => {
    console.log(`Starting image proxy on port ${port}`);
    serve({ fetch: app.fetch, port });
});
