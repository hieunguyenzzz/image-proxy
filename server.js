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
const KNOWN_WIDTHS = [64, 100, 128, 200, 384, 600, 800, 1024, 1080, 1200, 1440];
const CONTENT_PATHS = ['media', 'uploads', 'wp-content', 'swatchs'];
const TRANSFORM_RE = /^[a-z]_|^[a-z]+_[a-z]+|^f_|^c_|^q_|^v\d/;

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

// Normalize path: collapse transform segments between "upload/" and content path
// e.g. ["upload", "e_trim", "w_256", "f_auto", "media", ...] -> ["upload", "e_trim,w_256,f_auto", "media", ...]
const normalizePath = (segments) => {
    const uploadIdx = segments.indexOf('upload');
    if (uploadIdx === -1) return segments;

    const before = segments.slice(0, uploadIdx + 1);
    const after = segments.slice(uploadIdx + 1);

    const transforms = [];
    let contentStart = 0;
    for (let i = 0; i < after.length; i++) {
        // If this segment is a known content path, stop
        if (CONTENT_PATHS.includes(after[i])) {
            contentStart = i;
            break;
        }
        // If segment contains commas, it's already collapsed transforms — split and collect
        const parts = after[i].split(',');
        transforms.push(...parts);
        contentStart = i + 1;
    }

    const content = after.slice(contentStart);
    if (transforms.length > 0 && content.length > 0) {
        return [...before, transforms.join(','), ...content];
    }
    return segments;
};

const objectExists = async (key) => {
    try {
        await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        return true;
    } catch {
        return false;
    }
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

    // Normalize: collapse transform segments into single comma-separated segment
    const normalized = normalizePath(imageFile);
    const objectKey = normalized.join('/');

    // Also try the raw (un-normalized) key in case it was cached that way
    const rawKey = imageFile.join('/');

    // Check MinIO cache (try normalized first, then raw)
    for (const key of [objectKey, rawKey]) {
        try {
            if (await objectExists(key)) {
                return await serveFromMinIO(key, contentType);
            }
        } catch (e) {
            console.log('MinIO read error for ' + key);
        }
    }

    // Build CDN URL and ImageKit attributes from the normalized transforms
    const uploadIdx = normalized.indexOf('upload');
    const transformSegment = uploadIdx !== -1 ? (normalized[uploadIdx + 1] || '') : '';
    const imagekitAttributes = [];
    if (transformSegment.includes('e_trim')) imagekitAttributes.push('t-true');
    const wMatch = transformSegment.match(/w_(\d+)/);
    if (wMatch) imagekitAttributes.push('w-' + wMatch[1]);

    // Detect ImageKit uploads path
    const contentStart = uploadIdx !== -1 ? uploadIdx + 2 : 3;
    const firstContentSegment = normalized[contentStart] || '';

    let url = 'https://res.cloudinary.com/' + normalized.join('/');
    let imageBuffer = null;

    try {
        if (firstContentSegment === 'uploads' && normalized.length > contentStart + 2) {
            const alternativeUrl = 'https://ik.imagekit.io/tg3wenekj/' + [normalized[contentStart], normalized[contentStart + 1]].join('/') + '?tr=' + imagekitAttributes.join(',');
            console.log('downloading ' + alternativeUrl);
            imageBuffer = await downloadImage(alternativeUrl);
        } else {
            url = url.replace(',v', '/v');
            console.log('downloading ' + url);
            imageBuffer = await downloadImage(url);
        }
    } catch (err) {
        console.log('can not download ' + url);
    }

    // If CDN download failed, try closest cached width
    if (!imageBuffer) {
        const widthMatch = objectKey.match(/w_(\d+)/);
        if (widthMatch) {
            const requestedWidth = parseInt(widthMatch[1], 10);
            const sorted = [...KNOWN_WIDTHS]
                .filter(w => w !== requestedWidth)
                .sort((a, b) => {
                    const diffA = Math.abs(a - requestedWidth);
                    const diffB = Math.abs(b - requestedWidth);
                    if (diffA === diffB) return b - a;
                    return diffA - diffB;
                });

            const parts = objectKey.split('/');
            const upIdx = parts.indexOf('upload');
            if (upIdx !== -1) {
                const base = parts.slice(0, upIdx + 1).join('/');
                let imgStart = upIdx + 2; // skip transform segment
                const imagePath = parts.slice(imgStart).join('/');

                for (const w of sorted) {
                    const fallbackKey = base + '/e_trim,w_' + w + '/' + imagePath;
                    try {
                        if (await objectExists(fallbackKey)) {
                            console.log('fallback ' + objectKey + ' -> ' + fallbackKey);
                            return await serveFromMinIO(fallbackKey, contentType);
                        }
                    } catch {}
                }
            }
        }
        return c.text('Image not found', 404);
    }

    // Upload to MinIO in background (use normalized key)
    putObject(objectKey, imageBuffer, contentType).catch(err => {
        console.log('MinIO upload error for ' + objectKey, err.message);
    });

    return c.body(imageBuffer, 200, {
        'Content-Type': contentType,
        'Cache-Control': CACHE_CONTROL,
    });
});

const port = parseInt(process.env.PORT || '3000');
console.log(`Starting image proxy on port ${port}`);
serve({ fetch: app.fetch, port });
