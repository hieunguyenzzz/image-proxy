const { Hono } = require('hono');
const { serve } = require('@hono/node-server');
const { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Readable } = require('stream');

const app = new Hono();

const s3 = new S3Client({
    endpoint: process.env.MINIO_ENDPOINT,
    region: 'us-east-1',
    credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY,
        secretAccessKey: process.env.MINIO_SECRET_KEY,
    },
    forcePathStyle: true,
});

const BUCKET = process.env.MINIO_BUCKET || 'imageproxy-cache';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const KNOWN_WIDTHS = [64, 100, 128, 200, 256, 384, 512, 600, 640, 800, 856, 1024, 1080, 1200, 1440];
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
        if (CONTENT_PATHS.has(rest[i])) {
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

// Generate all key variants to check in MinIO
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
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
};

const serveFromMinIO = async (key, contentType) => {
    const { body } = await getObject(key);
    const nodeStream = body instanceof Readable ? body : Readable.fromWeb(body);
    return new Response(nodeStream, {
        headers: { 'Content-Type': contentType, 'Cache-Control': CACHE_CONTROL },
    });
};

// Health check
app.get('/', (c) => c.text('imageproxy ok'));

// Image proxy route
app.get('/api/images/*', async (c) => {
    let imageFile = decodeURIComponent(c.req.path).replace('/api/images/', '').split('/');
    imageFile = imageFile.filter(item => item !== 'mobelaris');
    imageFile = sanitizePath(imageFile);

    if (imageFile.length === 0) return c.text('Invalid path', 400);

    const name = imageFile[imageFile.length - 1];
    if (name === 'no_selection' || name === 'undefined') return c.text('Invalid image', 400);

    const contentType = getContentType(name);
    const parsed = parsePath(imageFile);
    const keys = generateKeys(parsed, imageFile);

    // Check MinIO cache — try all key variants
    for (const key of keys) {
        try {
            if (await objectExists(key)) {
                return await serveFromMinIO(key, contentType);
            }
        } catch {}
    }

    // Before hitting CDN, try closest cached width in MinIO
    if (parsed && parsed.contentPath) {
        const widthTransform = parsed.transforms.find(t => /^w_\d+$/.test(t));
        const otherTransforms = parsed.transforms.filter(t => !/^w_\d+$/.test(t));
        const requestedWidth = widthTransform ? parseInt(widthTransform.match(/\d+/)[0], 10) : 0;

        // Sort: prefer larger widths (better quality downscaled), then by closeness
        const widthsToTry = [...KNOWN_WIDTHS]
            .filter(w => w !== requestedWidth)
            .sort((a, b) => {
                const diffA = Math.abs(a - requestedWidth);
                const diffB = Math.abs(b - requestedWidth);
                if (diffA === diffB) return b - a;
                return diffA - diffB;
            });

        for (const w of widthsToTry) {
            const tryTransforms = [...otherTransforms, 'w_' + w];
            const fallbackKey = parsed.base + '/' + tryTransforms.join(',') + '/' + parsed.contentPath;
            try {
                if (await objectExists(fallbackKey)) {
                    console.log('serving nearest cached: ' + fallbackKey);
                    return await serveFromMinIO(fallbackKey, contentType);
                }
            } catch {}
        }

        // Also try with just otherTransforms (no width) — e.g. e_trim only
        if (otherTransforms.length > 0) {
            const noWidthKey = parsed.base + '/' + otherTransforms.join(',') + '/' + parsed.contentPath;
            try {
                if (await objectExists(noWidthKey)) {
                    console.log('serving nearest cached: ' + noWidthKey);
                    return await serveFromMinIO(noWidthKey, contentType);
                }
            } catch {}
        }
    }

    // Build CDN URL from the comma-joined normalized form
    const primaryKey = keys[0];
    const imagekitAttributes = [];
    if (parsed) {
        for (const t of parsed.transforms) {
            if (t === 'e_trim') imagekitAttributes.push('t-true');
            const wm = t.match(/^w_(\d+)$/);
            if (wm) imagekitAttributes.push('w-' + wm[1]);
        }
    }

    let url = 'https://res.cloudinary.com/' + primaryKey;
    let imageBuffer = null;

    // Try Cloudinary first, then ImageKit for uploads/ paths
    url = url.replace(',v', '/v');
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

    if (!imageBuffer) return c.text('Image not found', 404);

    // Upload to MinIO using comma-joined key (canonical format going forward)
    putObject(primaryKey, imageBuffer, contentType).catch(err => {
        console.log('MinIO upload error for ' + primaryKey, err.message);
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
