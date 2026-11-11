'use strict';

/**
 * Armazenamento remoto compativel com S3 (Cloudflare R2, AWS S3, MinIO...).
 *
 * Usado para publicar os arquivos de video (HLS, poster, smartautoplay e o mp4
 * original) fora da VPS. Toda a configuracao vem de fora (painel ou variaveis de
 * ambiente): nenhum dominio ou bucket fica fixo no codigo.
 */

const fs = require('fs');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { pipeline } = require('stream/promises');

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

const CONTENT_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/MP2T',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

function contentTypeFor(fileName) {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

let cachedClient = null;
let cachedClientKey = '';

function getClient(cfg) {
  const key = [cfg.endpoint, cfg.region, cfg.accessKey, cfg.secretKey].join('|');
  if (cachedClient && cachedClientKey === key) return cachedClient;
  cachedClient = new S3Client({
    region: cfg.region || 'auto',
    endpoint: cfg.endpoint || undefined,
    forcePathStyle: Boolean(cfg.forcePathStyle),
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey
    }
  });
  cachedClientKey = key;
  return cachedClient;
}

function cleanKey(key) {
  return String(key || '').replace(/^\/+/, '');
}

async function putFile(cfg, key, filePath, options = {}) {
  const client = getClient(cfg);
  const stat = fs.statSync(filePath);
  const params = {
    Bucket: cfg.bucket,
    Key: cleanKey(key),
    ContentType: options.contentType || contentTypeFor(filePath),
    CacheControl: options.cacheControl || IMMUTABLE_CACHE
  };

  // Arquivos pequenos (segmentos, playlists, imagens): PUT simples.
  if (stat.size <= 16 * 1024 * 1024) {
    params.Body = fs.readFileSync(filePath);
    await client.send(new PutObjectCommand(params));
    return;
  }

  // Arquivos grandes (mp4 original): upload multipart em streaming, sem
  // carregar o arquivo inteiro na memoria.
  params.Body = fs.createReadStream(filePath);
  const upload = new Upload({
    client,
    params,
    queueSize: 3,
    partSize: 16 * 1024 * 1024,
    leavePartsOnError: false
  });
  await upload.done();
}

async function downloadFile(cfg, key, destPath) {
  const client = getClient(cfg);
  const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: cleanKey(key) }));
  const tmpPath = destPath + '.download';
  await pipeline(res.Body, fs.createWriteStream(tmpPath));
  fs.renameSync(tmpPath, destPath);
}

async function listKeys(cfg, prefix) {
  const client = getClient(cfg);
  const keys = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: cfg.bucket,
      Prefix: cleanKey(prefix),
      ContinuationToken: token
    }));
    for (const obj of res.Contents || []) keys.push(obj.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function deletePrefix(cfg, prefix) {
  const p = cleanKey(prefix);
  // Protecao: nunca apagar o bucket inteiro por engano.
  if (!p || p.split('/').filter(Boolean).length < 2) {
    throw new Error(`Prefixo inseguro para exclusao: "${prefix}"`);
  }
  const client = getClient(cfg);
  const keys = await listKeys(cfg, p);
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    try {
      await client.send(new DeleteObjectsCommand({
        Bucket: cfg.bucket,
        Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true }
      }));
    } catch (err) {
      // Alguns provedores nao suportam DeleteObjects: apaga um a um.
      for (const Key of batch) {
        await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key }));
      }
    }
  }
  return keys.length;
}

// Grava, le e apaga um objeto de teste para validar credenciais e bucket.
async function testConnection(cfg) {
  const client = getClient(cfg);
  const key = `.cloudvturb-healthcheck/${Date.now()}.txt`;
  await client.send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    Body: 'ok',
    ContentType: 'text/plain',
    CacheControl: 'no-store'
  }));
  await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
}

// O player (iframe) busca o HLS via XHR em outro dominio: o bucket precisa de CORS.
async function ensureBucketCors(cfg) {
  const client = getClient(cfg);
  await client.send(new PutBucketCorsCommand({
    Bucket: cfg.bucket,
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: ['*'],
        AllowedMethods: ['GET', 'HEAD'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['Content-Length', 'Content-Range', 'Content-Type', 'Accept-Ranges', 'ETag'],
        MaxAgeSeconds: 86400
      }]
    }
  }));
}

module.exports = {
  IMMUTABLE_CACHE,
  contentTypeFor,
  putFile,
  downloadFile,
  listKeys,
  deletePrefix,
  testConnection,
  ensureBucketCors
};
