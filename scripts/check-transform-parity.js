// Does local rendering match what Cloudinary produced?
//
// Compares, for a sample of cache entries, the dimensions of the Cloudinary-rendered
// derivative already in R2 against the same transform applied locally by
// transformLocally() to the mirrored original. sharp's .trim() threshold is not
// guaranteed to pick the same bounding box as Cloudinary's e_trim, so this has to
// be measured before the local path is trusted ahead of Cloudinary.
//
// Costs nothing on Cloudinary: both sides are read from R2. Requires the originals
// to be mirrored first (scripts/mirror-cloudinary.js).
//
// Usage:
//   R2_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
//   node scripts/check-transform-parity.js [--prefix dfgbpib38/image/upload/e_trim,w_600] [--samples 20]

const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const { parsePath, originalKey, canRenderLocally, transformLocally } = require('../server.js');

const arg = (name, fallback) => {
    const i = process.argv.indexOf('--' + name);
    return i === -1 ? fallback : process.argv[i + 1];
};
const PREFIX = arg('prefix', 'dfgbpib38/image/upload/e_trim,w_600/');
const SAMPLES = parseInt(arg('samples', '20'), 10);
const BUCKET = process.env.R2_BUCKET || 'imageproxy-cache';

const s3 = new S3Client({
    endpoint: process.env.R2_ENDPOINT,
    region: 'auto',
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
});

const fetchKey = async (key) => {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of Body) chunks.push(chunk);
    return Buffer.concat(chunks);
};

const dims = async (buffer) => {
    const { width, height } = await sharp(buffer).metadata();
    return { width, height };
};

async function main() {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, MaxKeys: SAMPLES * 5 }));
    const keys = (listed.Contents || []).map(o => o.Key);
    if (!keys.length) {
        console.error(`No cache entries under ${PREFIX}`);
        process.exit(1);
    }

    let matched = 0, mismatched = 0, unmirrored = 0, errored = 0;

    for (const key of keys) {
        if (matched + mismatched >= SAMPLES) break;

        const parsed = parsePath(key.split('/'));
        if (!parsed || !canRenderLocally(parsed.transforms)) continue;

        const origKey = originalKey(parsed);
        let original;
        try {
            original = await fetchKey(origKey);
        } catch {
            unmirrored++;
            continue;
        }

        try {
            const [cloudinary, local] = await Promise.all([
                fetchKey(key).then(dims),
                transformLocally(original, parsed.transforms).then(dims),
            ]);

            const ok = cloudinary.width === local.width && cloudinary.height === local.height;
            if (ok) matched++; else mismatched++;

            console.log(
                `${ok ? 'MATCH   ' : 'MISMATCH'} cloudinary=${cloudinary.width}x${cloudinary.height} ` +
                `local=${local.width}x${local.height}  ${key.replace(PREFIX, '')}`
            );
        } catch (err) {
            console.log(`ERROR    ${key}: ${err.message}`);
            errored++;
        }
    }

    console.log(`\nmatched: ${matched}, mismatched: ${mismatched}, errored: ${errored}, original not mirrored: ${unmirrored}`);
    if (mismatched > 0) {
        console.log('Dimensions differ — tune the .trim() threshold in transformLocally before trusting the local path.');
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
