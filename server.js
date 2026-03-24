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

// Health check
app.get('/', (c) => c.text('imageproxy ok'));

// Image proxy route
app.get('/api/images/*', async (c) => {
    let imageFile = c.req.path.replace('/api/images/', '').split('/');
    imageFile = imageFile.filter(item => item !== 'mobelaris');
    imageFile = sanitizePath(imageFile);

    if (imageFile.length === 0) return c.text('Invalid path', 400);

    const name = imageFile[imageFile.length - 1];
    if (name === 'no_selection' || name === 'undefined') return c.text('Invalid image', 400);

    const contentType = getContentType(name);

    // Build CDN URL with transformation mapping (must happen before cache check
    // because the old cache used transformed paths)
    let cloudinaryAttributes = [];
    let imagekitAttributes = [];
    const segment4 = imageFile[4] || '';
    const segment3 = imageFile[3] || '';

    if (segment4.includes('media') || segment4.includes('mobelaris') || segment4.includes('uploads') || segment4.includes('wp-content') || segment4.includes('e_trim')) {
        if (segment3.includes('e_trim')) {
            imagekitAttributes.push('t-true');
            cloudinaryAttributes.push('e_trim');
        }
        if (segment3.includes('w_')) {
            const match = segment3.match(/w_(\d+)/);
            if (match) {
                const number = parseInt(match[1], 10);
                cloudinaryAttributes.push('w_' + number);
                imagekitAttributes.push('w-' + number);
            }
        }
        if (cloudinaryAttributes.length > 0 && imageFile.length > 3) {
            imageFile[3] = cloudinaryAttributes.join(',');
        }
    }

    // Cache key uses the transformed path (matches old filesystem cache structure)
    const objectKey = imageFile.join('/');

    // Check MinIO cache
    try {
        if (await objectExists(objectKey)) {
            const { body } = await getObject(objectKey);
            const nodeStream = body instanceof Readable ? body : Readable.fromWeb(body);
            return new Response(nodeStream, {
                headers: {
                    'Content-Type': contentType,
                    'Cache-Control': CACHE_CONTROL,
                },
            });
        }
    } catch (e) {
        console.log('MinIO read error, falling through to CDN');
    }

    // Download from CDN
    let url = 'https://res.cloudinary.com/' + imageFile.join('/');
    let imageBuffer = null;

    try {
        if (segment4.includes('uploads') && imageFile.length > 5) {
            const alternativeUrl = 'https://ik.imagekit.io/tg3wenekj/' + [imageFile[4], imageFile[5]].join('/') + '?tr=' + imagekitAttributes.join(',');
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
            // Sort known widths by closeness (prefer larger over smaller)
            const sorted = [...KNOWN_WIDTHS]
                .filter(w => w !== requestedWidth)
                .sort((a, b) => {
                    const diffA = Math.abs(a - requestedWidth);
                    const diffB = Math.abs(b - requestedWidth);
                    if (diffA === diffB) return b - a; // prefer larger
                    return diffA - diffB;
                });

            // Extract the image path after transformation segments
            // e.g. "dfgbpib38/image/upload/e_trim/w_856/media/..." -> base="dfgbpib38/image/upload", imagePath="media/..."
            const parts = objectKey.split('/');
            const uploadIdx = parts.indexOf('upload');
            if (uploadIdx !== -1) {
                const base = parts.slice(0, uploadIdx + 1).join('/');
                // Find where the actual image path starts (first segment that's not a transform)
                let imagePathStart = uploadIdx + 1;
                while (imagePathStart < parts.length && /^[a-z0-9_,]+$/.test(parts[imagePathStart]) && !['media', 'uploads', 'wp-content', 'swatchs'].includes(parts[imagePathStart])) {
                    imagePathStart++;
                }
                const imagePath = parts.slice(imagePathStart).join('/');

                for (const w of sorted) {
                    const fallbackKey = base + '/e_trim,w_' + w + '/' + imagePath;
                    try {
                        if (await objectExists(fallbackKey)) {
                            console.log('fallback ' + objectKey + ' -> ' + fallbackKey);
                            const { body } = await getObject(fallbackKey);
                            const nodeStream = body instanceof Readable ? body : Readable.fromWeb(body);
                            return new Response(nodeStream, {
                                headers: {
                                    'Content-Type': contentType,
                                    'Cache-Control': CACHE_CONTROL,
                                },
                            });
                        }
                    } catch {}
                }
            }
        }
        return c.text('Image not found', 404);
    }

    // Upload to MinIO in background
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
