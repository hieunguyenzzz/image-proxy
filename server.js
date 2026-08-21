const { Hono } = require('hono');
const { serve } = require('@hono/node-server');
const { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const sharp = require('sharp');
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
// The bytes at a given URL never change, so the edge copy keeps the full year —
// Cloudflare prefers s-maxage for edge TTL, so offload is unchanged. The browser
// copy is capped at a day and drops `immutable` because it is the one layer we
// cannot purge: two separate bugs shipped wrong bytes under correct URLs, and
// `immutable` tells browsers not to revalidate even on an explicit reload, which
// left users with no way to recover.
const CACHE_CONTROL = 'public, max-age=86400, s-maxage=31536000';
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

const getObjectBuffer = async (key) => {
    const { body } = await getObject(key);
    const stream = body instanceof Readable ? body : Readable.fromWeb(body);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
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

// The mirrored original sits at the content path with no transformation component
// (see scripts/mirror-cloudinary.js). parsePath folds a `v1686913543` version
// segment into contentPath, so strip it — otherwise a versioned request never
// matches the mirrored key and falls through to Cloudinary for nothing.
const originalKey = (parsed) => {
    if (!parsed || !parsed.contentPath) return null;
    const segments = parsed.contentPath.split('/');
    const path = isVersion(segments[0]) ? segments.slice(1).join('/') : parsed.contentPath;
    return path ? parsed.base + '/' + path : null;
};

// Only these four appear in the 136 transform combinations the cache has ever
// held. Anything else must go to Cloudinary rather than be silently dropped —
// ignoring an unrecognised transform would cache a wrong render under a correct
// URL, which is exactly how the two previous wrong-bytes incidents happened.
const LOCAL_TRANSFORMS = /^(e_trim|c_limit|f_auto|w_\d+)$/;
const canRenderLocally = (transforms) => transforms.every(t => LOCAL_TRANSFORMS.test(t));

// Render a derived image from the mirrored original so a cache miss no longer
// needs Cloudinary. Trim runs as its own pass before the resize, matching the
// order buildCloudinaryUrl forces for the same reason: trim -> resize is what the
// request path asked for, and the reverse crops the whitespace away after the
// resize and returns far less than the requested width.
//
// `withoutEnlargement` tracks c_limit and nothing else, because that is precisely
// what c_limit means. Without c_limit Cloudinary *does* upscale past the original,
// so we must too: many product shots are a portrait subject on a wide white canvas,
// so e_trim leaves something like 641x849 out of a 1920x850 original, and the live
// site requests e_trim,w_1440 of it. Refusing to enlarge would quietly start
// serving 641px where 1440px is cached today — a visible regression on the same URL.
// Measured on media/catalog/product/1/0/109_1.png: Cloudinary 1440x1907, trimmed
// original 641x849, identical aspect ratio.
//
// This does not reopen the upscaling incident that CLAUDE.md warns about. That was
// chained derivation — a w_600 built from an already-derived 200px cache entry, then
// reused as a source. Here the source is always the mirrored full original.
//
// f_auto is a no-op: toBuffer() keeps the source format, and the Content-Type is
// derived from the extension anyway, so the two stay consistent.
//
// The requested width always comes out exact, but the trim box is not identical to
// Cloudinary's on alpha PNGs whose subject fades to transparent at the canvas edge:
// sharp trims those rows, Cloudinary keeps them. Measured spread on real assets is
// 0.1%-12% of height (0v8a3233.png: 1440x1848 local vs 1440x1931 Cloudinary). The
// default trim() is the closest available — threshold 0, an explicit white
// background and pre-flattening were all measured worse. This only affects renders
// that Cloudinary would otherwise have produced fresh; entries already cached are
// served untouched, so nothing currently on the site changes.
const transformLocally = async (buffer, transforms) => {
    let bytes = buffer;
    if (transforms.includes('e_trim')) {
        bytes = await sharp(bytes, { failOn: 'none' }).trim().toBuffer();
    }
    const width = transforms.map(t => t.match(/^w_(\d+)$/)).find(Boolean);
    if (!width) return bytes;
    return sharp(bytes, { failOn: 'none' })
        .resize({ width: parseInt(width[1], 10), withoutEnlargement: transforms.includes('c_limit') })
        .toBuffer();
};

// Instagram gallery photos predating the Cloudinary uploads live only behind the
// legacy feed proxy — they are in no Cloudinary account, so the Cloudinary upstream
// would 404 them. Their bytes were copied into this bucket under
// `<prefix>/<postId>.jpg` (original) and `<prefix>/w600/<postId>.jpg` (the largest
// size any component renders), so in practice every request is a cache hit. This
// upstream only fires for a postId that was never seeded — a newly added gallery row
// — and keeps it from serving a 404 instead of a photo. Note there is no resizing
// here, so a self-healed `w600` key holds the full-size original.
//
// The prefix picks the Instagram account, because this proxy serves both brands off
// one bucket and the same postId space: `instagram/` is Mobelaris, `instagram-de/` is
// DesignerEditions. Both fetch from the *mobelaris* feed host on purpose — the service
// is multi-tenant (it takes the account as a query param) and the DE-branded host
// `shopify-app-instagram-feed.designereditions.com` has been returning 504.
const INSTAGRAM_ACCOUNTS = {
    'instagram': 'mobelarisfurniture',
    'instagram-de': 'designer_editions_uk',
};
const instagramUpstream = (segments) => {
    const username = INSTAGRAM_ACCOUNTS[segments[0]];
    if (!username) return null;
    const postId = segments[segments.length - 1].replace(/\.[a-z0-9]+$/i, '');
    // Numeric post ids plus the handful of named assets (e.g. `icon`, the profile
    // avatar). sanitizePath has already stripped traversal, so this only has to keep
    // the query param well-formed.
    if (!/^[A-Za-z0-9_-]+$/.test(postId)) return null;
    return 'https://shopify-app-instagram-feed.mobelaris.com/instagram-image'
        + `?postId=${postId}&username=${username}`;
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

    const instagramUrl = instagramUpstream(imageFile);
    const url = instagramUrl || buildCloudinaryUrl(parsed, imageFile);
    let imageBuffer = null;

    // Render from the mirrored original in R2 before paying Cloudinary. The account
    // is over its plan quota, so any miss that the mirror can serve must not leave
    // the network. This derives from the full original, never from a derived cache
    // entry, so the upscaling trap above does not apply.
    const origKey = instagramUrl ? null : originalKey(parsed);
    if (origKey && !keys.includes(origKey) && canRenderLocally(parsed.transforms)) {
        try {
            if (await objectExists(origKey)) {
                imageBuffer = await transformLocally(await getObjectBuffer(origKey), parsed.transforms);
                console.log('rendered locally from ' + origKey);
            }
        } catch (err) {
            console.log('local render failed for ' + origKey + ': ' + err.message);
            imageBuffer = null;
        }
    }

    // Try Cloudinary first, then ImageKit for uploads/ paths
    if (!imageBuffer) {
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
// Guarded so the transform helpers can be required directly by
// scripts/check-transform-parity.js without starting a listener.
if (require.main === module) {
    warmup().then(() => {
        console.log(`Starting image proxy on port ${port}`);
        serve({ fetch: app.fetch, port });
    });
}

module.exports = { parsePath, originalKey, canRenderLocally, transformLocally, buildCloudinaryUrl };
