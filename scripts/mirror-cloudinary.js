// Mirror every Cloudinary original into the R2 cache bucket, so the proxy can
// render derivatives locally instead of calling Cloudinary (see transformLocally
// in server.js). The account is over its Free-plan credit limit and will be cut
// off; once this has run, a miss no longer depends on Cloudinary being up.
//
// Only the untransformed secure_url is fetched, which costs bandwidth credits and
// *no* transformation credits.
//
// Safe to re-run: every asset is HeadObject-checked first, so an interrupted run
// resumes by skipping what already landed. Listing the whole library is ~52 Admin
// API calls against a 500/hour limit.
//
// Usage:
//   R2_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
//   CLOUDINARY_API_KEY=... CLOUDINARY_API_SECRET=... \
//   node scripts/mirror-cloudinary.js [--limit 50] [--prefix media] [--concurrency 8]

const { S3Client, HeadObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const CLOUDINARY_CLOUD = process.env.CLOUDINARY_CLOUD_NAME || 'dfgbpib38';
const CLOUDINARY_API = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}`;

for (const required of ['CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    if (!process.env[required]) {
        console.error(`Missing required env var: ${required}`);
        process.exit(1);
    }
}

const AUTH_HEADER = 'Basic ' + Buffer.from(`${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}`).toString('base64');

const arg = (name, fallback) => {
    const i = process.argv.indexOf('--' + name);
    return i === -1 ? fallback : process.argv[i + 1];
};
const LIMIT = parseInt(arg('limit', '0'), 10);
const PREFIX = arg('prefix', '');
const CONCURRENCY = parseInt(arg('concurrency', '8'), 10);

const BUCKET = process.env.R2_BUCKET || 'imageproxy-cache';
// Same header the proxy writes, so a mirrored original is indistinguishable from
// one the proxy cached itself.
const CACHE_CONTROL = 'public, max-age=86400, s-maxage=31536000';

const s3 = new S3Client({
    endpoint: process.env.R2_ENDPOINT,
    region: 'auto',
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
});

const objectExists = async (key) => {
    try {
        await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        return true;
    } catch { return false; }
};

const getContentType = (format) => {
    const f = (format || '').toLowerCase();
    if (f === 'png') return 'image/png';
    if (f === 'jpg' || f === 'jpeg') return 'image/jpeg';
    if (f === 'webp') return 'image/webp';
    if (f === 'gif') return 'image/gif';
    if (f === 'svg') return 'image/svg+xml';
    return 'image/jpeg';
};

async function listAll() {
    const all = [];
    let cursor = null;

    while (true) {
        const url = `${CLOUDINARY_API}/resources/image?type=upload&max_results=500` +
            (PREFIX ? `&prefix=${encodeURIComponent(PREFIX)}` : '') +
            (cursor ? `&next_cursor=${cursor}` : '');

        const res = await fetch(url, { headers: { 'Authorization': AUTH_HEADER } });
        if (!res.ok) throw new Error(`Admin API ${res.status}: ${await res.text()}`);
        const data = await res.json();

        if (data.resources) all.push(...data.resources);
        console.log(`Listed ${all.length} resources so far...`);

        if (!data.next_cursor || (LIMIT && all.length >= LIMIT)) break;
        cursor = data.next_cursor;
    }

    return LIMIT ? all.slice(0, LIMIT) : all;
}

async function main() {
    console.log(`Listing image resources from ${CLOUDINARY_CLOUD}${PREFIX ? ` (prefix ${PREFIX})` : ''}...`);
    const images = await listAll();
    console.log(`Mirroring ${images.length} originals into ${BUCKET} with concurrency ${CONCURRENCY}\n`);

    let mirrored = 0, skipped = 0, failed = 0, bytes = 0, next = 0;

    const worker = async () => {
        while (next < images.length) {
            const img = images[next++];
            // The exact path the proxy looks up for an untransformed asset:
            // dfgbpib38/image/upload/<public_id>.<format>
            const key = `${CLOUDINARY_CLOUD}/image/upload/${img.public_id}.${img.format}`;

            try {
                if (await objectExists(key)) {
                    skipped++;
                    continue;
                }

                const res = await fetch(img.secure_url);
                if (!res.ok) {
                    console.log(`FAIL download ${img.public_id} (${res.status})`);
                    failed++;
                    continue;
                }

                const buffer = Buffer.from(await res.arrayBuffer());
                await s3.send(new PutObjectCommand({
                    Bucket: BUCKET,
                    Key: key,
                    Body: buffer,
                    ContentType: getContentType(img.format),
                    CacheControl: CACHE_CONTROL,
                }));

                mirrored++;
                bytes += buffer.length;
                if (mirrored % 100 === 0) {
                    console.log(`mirrored ${mirrored}, skipped ${skipped}, failed ${failed}, ${(bytes / 1073741824).toFixed(2)} GiB pulled`);
                }
            } catch (err) {
                console.log(`ERROR ${img.public_id}: ${err.message}`);
                failed++;
            }
        }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    console.log(`\nDone. Mirrored: ${mirrored}, already present: ${skipped}, failed: ${failed}`);
    console.log(`Bandwidth pulled from Cloudinary: ${(bytes / 1073741824).toFixed(2)} GiB`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
