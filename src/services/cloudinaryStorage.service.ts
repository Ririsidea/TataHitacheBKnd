import { v2 as cloudinary } from 'cloudinary';
import { cloudinary as cloudinaryConfig } from '../config/env';
import { ConfigError, errorMessage } from '../utils/errors';

export interface CloudinaryRawFile {
  publicId: string;
  resourceType: 'raw';
  type: 'private';
  version: number | null;
  bytes: number | null;
  format: string;
}

export function cloudinaryFileFromRecord(record: {
  cloudinaryPublicId?: string | null;
  cloudinaryResourceType?: string | null;
  cloudinaryType?: string | null;
  cloudinaryVersion?: number | null;
  cloudinaryBytes?: number | null;
  cloudinaryFormat?: string | null;
}): CloudinaryRawFile | null {
  if (!record.cloudinaryPublicId) return null;
  return {
    publicId: record.cloudinaryPublicId,
    resourceType: (record.cloudinaryResourceType || 'raw') as 'raw',
    type: (record.cloudinaryType || 'private') as 'private',
    version: record.cloudinaryVersion ?? null,
    bytes: record.cloudinaryBytes ?? null,
    format: record.cloudinaryFormat || 'xlsx',
  };
}

function configure(): void {
  const { cloudName, apiKey, apiSecret } = cloudinaryConfig;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new ConfigError('Cloudinary export storage is not configured');
  }
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
}

export function cloudinaryExportConfigured(): boolean {
  return Boolean(cloudinaryConfig.cloudName && cloudinaryConfig.apiKey && cloudinaryConfig.apiSecret);
}

let startupPing: Promise<void> | null = null;

// One authenticated connection check per process. A nodemon restart creates a new process and
// therefore performs one normal startup check; repeated callers in the same process share it.
export function verifyCloudinaryConnection(): Promise<void> {
  if (!startupPing) {
    startupPing = (async () => {
      configure();
      await cloudinary.api.ping();
    })();
  }
  return startupPing;
}

export function sanitizedCloudinaryError(error: unknown): string {
  let message = errorMessage(error);
  for (const credential of [cloudinaryConfig.apiSecret, cloudinaryConfig.apiKey, cloudinaryConfig.cloudName]) {
    if (credential) message = message.split(credential).join('[redacted]');
  }
  return message
    .replace(/(api[_-]?(?:key|secret)|authorization|token|signature)\s*[:=]\s*[^,\s]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

export async function uploadPrivateRawXlsx(buffer: Buffer, publicId: string): Promise<CloudinaryRawFile> {
  configure();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw',
        type: 'private',
        public_id: publicId,
        format: 'xlsx',
        overwrite: true,
        invalidate: true,
      },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error('Cloudinary upload returned no result'));
          return;
        }
        resolve({
          publicId: result.public_id,
          resourceType: 'raw',
          type: 'private',
          version: typeof result.version === 'number' ? result.version : null,
          bytes: typeof result.bytes === 'number' ? result.bytes : null,
          format: result.format || 'xlsx',
        });
      }
    );
    stream.end(buffer);
  });
}

export function privateDownloadUrl(file: CloudinaryRawFile): string {
  configure();
  return cloudinary.utils.private_download_url(file.publicId, file.format || 'xlsx', {
    resource_type: file.resourceType,
    type: file.type,
    attachment: true,
  });
}

export async function downloadPrivateRawFile(file: CloudinaryRawFile): Promise<Buffer> {
  const response = await fetch(privateDownloadUrl(file));
  if (!response.ok) throw new Error(`Cloudinary download failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

export async function destroyPrivateRawFile(file: CloudinaryRawFile): Promise<void> {
  configure();
  await new Promise<void>((resolve, reject) => {
    cloudinary.uploader.destroy(
      file.publicId,
      { resource_type: file.resourceType, type: file.type, invalidate: true },
      (error) => (error ? reject(error) : resolve())
    );
  });
}
