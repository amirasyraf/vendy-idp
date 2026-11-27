import {
  BucketLocationConstraint,
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketTaggingCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ClientSecretCredential } from '@azure/identity';
import {
  BlobSASPermissions,
  BlobServiceClient,
  ContainerSASPermissions,
  generateBlobSASQueryParameters,
  SASProtocol,
} from '@azure/storage-blob';

export type Platform = 'aws' | 'azure';
type Target = { id: string; cloud_name: string };
type ObjectInfo = {
  key: string;
  size: number;
  updatedAt?: string;
  etag: string;
};
type ListResult = { folders: string[]; objects: ObjectInfo[]; next?: string };
type Usage = { objects: number; bytes: number; complete: boolean };
type Grant = { url: string; headers?: Record<string, string> };
export type UploadCredentials =
  | {
      platform: 'aws';
      expiresAt: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken: string;
    }
  | { platform: 'azure'; expiresAt: string; url: string; sas: string };

export interface BucketStorage {
  provision(target: Target): Promise<void>;
  list(target: Target, prefix: string, cursor?: string): Promise<ListResult>;
  usage(target: Target): Promise<Usage>;
  stat(target: Target, key: string): Promise<ObjectInfo | undefined>;
  upload(
    target: Target,
    key: string,
    size: number,
    etag?: string,
  ): Promise<Grant>;
  download(target: Target, key: string, name?: string): Promise<Grant>;
  remove(target: Target, key: string, etag: string): Promise<void>;
  move(target: Target, key: string, to: string, etag: string): Promise<void>;
  issue(
    target: Target,
    minutes: number,
    issuanceId: string,
  ): Promise<UploadCredentials>;
}

export const maxWebBytes = 4 * 1024 ** 3;
export class MoveIncomplete extends Error {
  constructor() {
    super(
      'The destination was copied, but the source could not be safely deleted. Refresh and check both paths.',
    );
  }
}
const signedSeconds = 5 * 60;
const usagePageSize = 1000;
const deadline = () => AbortSignal.timeout(18_000);
const headersFor = (etag?: string): Record<string, string> =>
  etag ? { 'if-match': etag } : { 'if-none-match': '*' };
const disposition = (name: string) =>
  `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(
    /['()*]/g,
    char => `%${char.charCodeAt(0).toString(16)}`,
  )}`;
const objectInfo = (
  key: string,
  size: number | undefined,
  etag: string | undefined,
  modified?: Date,
): ObjectInfo => {
  if (size === undefined || !etag)
    throw new Error('Object metadata is incomplete');
  // Azure list responses omit the quotes present in HTTP ETag headers.
  const version = etag.startsWith('"') ? etag : `"${etag}"`;
  return { key, size, etag: version, updatedAt: modified?.toISOString() };
};

export function storageStatus(error: unknown): number | undefined {
  const cloud = error as
    | { statusCode?: number; $metadata?: { httpStatusCode?: number } }
    | undefined;
  return cloud?.statusCode ?? cloud?.$metadata?.httpStatusCode;
}

async function optional<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    if (storageStatus(error) !== 404) throw error;
    return undefined;
  }
}

export function awsStorage(options: {
  account: string;
  region: string;
  uploadRole: string;
  origin: string;
}): BucketStorage {
  const { account, region, uploadRole, origin } = options;
  const s3 = new S3Client({
    region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  const sts = new STSClient({ region });
  const bucket = (target: Target) => ({
    Bucket: target.cloud_name,
    ExpectedBucketOwner: account,
  });
  const object = (target: Target, key: string) => ({
    ...bucket(target),
    Key: key,
  });
  const abort = () => ({ abortSignal: deadline() });
  return {
    async provision(target) {
      const tags = [
        { Key: 'cf:poc', Value: 'true' },
        { Key: 'cf:module', Value: 'buckets' },
        { Key: 'cf:bucket-id', Value: target.id },
      ];
      try {
        await s3.send(
          new CreateBucketCommand({
            Bucket: target.cloud_name,
            CreateBucketConfiguration: {
              LocationConstraint: region as BucketLocationConstraint,
              Tags: tags,
            },
          }),
          abort(),
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== 'BucketAlreadyOwnedByYou'
        )
          throw error;
      }
      const scope = bucket(target);
      const { TagSet } = await s3.send(
        new GetBucketTaggingCommand(scope),
        abort(),
      );
      if (
        !tags.every(tag =>
          TagSet?.some(
            value => value.Key === tag.Key && value.Value === tag.Value,
          ),
        )
      )
        throw new Error('S3 bucket ownership markers do not match');
      // Complete the public access block before installing any access rules.
      await s3.send(
        new PutPublicAccessBlockCommand({
          ...scope,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }),
        abort(),
      );
      // S3 rejects overlapping writes to the same bucket configuration.
      await s3.send(
        new PutBucketCorsCommand({
          ...scope,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: [origin],
                AllowedMethods: ['PUT', 'GET'],
                AllowedHeaders: [
                  'content-type',
                  'if-match',
                  'if-none-match',
                  'x-amz-*',
                ],
                MaxAgeSeconds: 300,
              },
            ],
          },
        }),
        abort(),
      );
      await s3.send(
        new PutBucketPolicyCommand({
          ...scope,
          Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Deny',
                Principal: '*',
                Action: 's3:*',
                Resource: [
                  `arn:aws:s3:::${scope.Bucket}`,
                  `arn:aws:s3:::${scope.Bucket}/*`,
                ],
                Condition: { Bool: { 'aws:SecureTransport': 'false' } },
              },
            ],
          }),
        }),
        abort(),
      );
      await s3.send(
        new PutBucketLifecycleConfigurationCommand({
          ...scope,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: 'abort-incomplete-uploads',
                Filter: { Prefix: '' },
                Status: 'Enabled',
                AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
              },
            ],
          },
        }),
        abort(),
      );
    },
    async list(target, prefix, cursor) {
      const page = await s3.send(
        new ListObjectsV2Command({
          ...bucket(target),
          Prefix: prefix,
          Delimiter: '/',
          MaxKeys: 100,
          ContinuationToken: cursor,
          EncodingType: 'url',
        }),
        abort(),
      );
      return {
        folders: (page.CommonPrefixes ?? []).flatMap(entry =>
          entry.Prefix ? [decodeURIComponent(entry.Prefix)] : [],
        ),
        objects: (page.Contents ?? []).flatMap(entry =>
          entry.Key
            ? [
                objectInfo(
                  decodeURIComponent(entry.Key),
                  entry.Size,
                  entry.ETag,
                  entry.LastModified,
                ),
              ]
            : [],
        ),
        next: page.NextContinuationToken,
      };
    },
    async usage(target) {
      const page = await s3.send(
        new ListObjectsV2Command({
          ...bucket(target),
          MaxKeys: usagePageSize,
          EncodingType: 'url',
        }),
        abort(),
      );
      const objects = page.Contents ?? [];
      return {
        objects: objects.length,
        bytes: objects.reduce((total, entry) => total + (entry.Size ?? 0), 0),
        complete: !page.IsTruncated,
      };
    },
    async stat(target, key) {
      const result = await optional(
        s3.send(new HeadObjectCommand(object(target, key)), abort()),
      );
      return (
        result &&
        objectInfo(key, result.ContentLength, result.ETag, result.LastModified)
      );
    },
    async upload(target, key, size, etag) {
      const headers = headersFor(etag);
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: target.cloud_name,
          Key: key,
          ContentLength: size,
          ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
        }),
        {
          expiresIn: signedSeconds,
          signableHeaders: new Set(Object.keys(headers)),
        },
      );
      return { url, headers };
    },
    async download(target, key, name) {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: target.cloud_name,
          Key: key,
          ResponseContentType: 'application/octet-stream',
          ResponseContentDisposition:
            name === undefined ? undefined : disposition(name),
          ResponseCacheControl: 'no-store',
        }),
        { expiresIn: signedSeconds },
      );
      return { url };
    },
    async remove(target, key, etag) {
      await s3.send(
        new DeleteObjectCommand({ ...object(target, key), IfMatch: etag }),
        abort(),
      );
    },
    async move(target, key, to, etag) {
      await s3.send(
        new CopyObjectCommand({
          ...object(target, to),
          ExpectedSourceBucketOwner: account,
          CopySource: `${target.cloud_name}/${key
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`,
          CopySourceIfMatch: etag,
          IfNoneMatch: '*',
        }),
        abort(),
      );
      await this.remove(target, key, etag).catch(() => {
        throw new MoveIncomplete();
      });
    },
    async issue(target, minutes, issuanceId) {
      const { Credentials } = await sts.send(
        new AssumeRoleCommand({
          RoleArn: uploadRole,
          RoleSessionName: `vendy-${issuanceId}`,
          DurationSeconds: minutes * 60,
          Tags: [{ Key: 'vendy-bucket', Value: target.cloud_name }],
          Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['s3:PutObject', 's3:AbortMultipartUpload'],
                Resource: `arn:aws:s3:::${target.cloud_name}/*`,
              },
            ],
          }),
        }),
        abort(),
      );
      if (
        !Credentials?.AccessKeyId ||
        !Credentials.SecretAccessKey ||
        !Credentials.SessionToken ||
        !Credentials.Expiration
      )
        throw new Error('AWS did not return complete upload credentials');
      return {
        platform: 'aws',
        region,
        bucket: target.cloud_name,
        expiresAt: Credentials.Expiration.toISOString(),
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretAccessKey,
        sessionToken: Credentials.SessionToken,
      };
    },
  };
}

export function azureStorage(options: {
  account: string;
  secretId: string;
  region: string;
}): BucketStorage {
  const { account, secretId, region } = options;
  const secrets = new SecretsManagerClient({ region });
  const endpoint = `https://${account}.blob.core.windows.net`;
  let cached: { until: number; client: Promise<BlobServiceClient> } | undefined;
  const client = () => {
    if (!cached || cached.until <= Date.now()) {
      const promise = (async () => {
        const result = await secrets.send(
          new GetSecretValueCommand({ SecretId: secretId }),
          { abortSignal: deadline() },
        );
        const { tenantId, clientId, clientSecret } = JSON.parse(
          result.SecretString ?? '{}',
        );
        if (
          ![tenantId, clientId, clientSecret].every(
            value => typeof value === 'string' && value,
          )
        )
          throw new Error('Azure bucket identity is incomplete');
        return new BlobServiceClient(
          endpoint,
          new ClientSecretCredential(tenantId, clientId, clientSecret),
          {
            retryOptions: { maxTries: 2 },
          },
        );
      })();
      cached = { until: Date.now() + 60 * 60_000, client: promise };
      promise.catch(() => {
        if (cached?.client === promise) cached = undefined;
      });
    }
    return cached.client;
  };
  const container = async (target: Target) =>
    (await client()).getContainerClient(target.cloud_name);
  const blob = async (target: Target, key: string) =>
    (await container(target)).getBlockBlobClient(key);
  let signingKey:
    | {
        until: number;
        key: ReturnType<BlobServiceClient['getUserDelegationKey']>;
      }
    | undefined;
  async function sign(
    target: Target,
    expiresOn: Date,
    permissions: BlobSASPermissions | ContainerSASPermissions,
    key?: string,
    name?: string,
    correlationId?: string,
    download = false,
  ) {
    if (!signingKey || signingKey.until <= expiresOn.getTime() + 60_000) {
      const now = Date.now();
      const end = new Date(now + 9 * 60 * 60_000);
      const pending = client().then(storage =>
        storage.getUserDelegationKey(new Date(now - 5 * 60_000), end, {
          abortSignal: deadline(),
        }),
      );
      signingKey = { until: end.getTime(), key: pending };
      pending.catch(() => {
        if (signingKey?.key === pending) signingKey = undefined;
      });
    }
    return generateBlobSASQueryParameters(
      {
        containerName: target.cloud_name,
        blobName: key,
        expiresOn,
        permissions,
        protocol: SASProtocol.Https,
        contentType: download ? 'application/octet-stream' : undefined,
        contentDisposition: name === undefined ? undefined : disposition(name),
        cacheControl: download ? 'no-store' : undefined,
        correlationId,
      },
      await signingKey.key,
      account,
    ).toString();
  }
  const signedBlob = async (
    target: Target,
    key: string,
    permissions: string,
    name?: string,
  ) => {
    const url = (await blob(target, key)).url;
    const token = await sign(
      target,
      new Date(Date.now() + signedSeconds * 1000),
      BlobSASPermissions.parse(permissions),
      key,
      name,
      undefined,
      permissions === 'r',
    );
    return `${url}?${token}`;
  };
  return {
    async provision(target) {
      const resource = await container(target);
      const metadata = { vendybucket: target.id };
      const result = await resource.createIfNotExists({
        metadata,
        abortSignal: deadline(),
      });
      if (
        !result.succeeded &&
        (await resource.getProperties({ abortSignal: deadline() })).metadata
          ?.vendybucket !== target.id
      )
        throw new Error('Azure container ownership marker does not match');
    },
    async list(target, prefix, cursor) {
      const pages = (await container(target))
        .listBlobsByHierarchy('/', { prefix, abortSignal: deadline() })
        .byPage({ continuationToken: cursor, maxPageSize: 100 });
      const result = await pages.next();
      if (result.done) return { folders: [], objects: [] };
      const page = result.value;
      return {
        folders: (page.segment.blobPrefixes ?? []).map(entry => entry.name),
        objects: page.segment.blobItems.map(entry =>
          objectInfo(
            entry.name,
            entry.properties.contentLength,
            entry.properties.etag,
            entry.properties.lastModified,
          ),
        ),
        next: page.continuationToken || undefined,
      };
    },
    async usage(target) {
      const pages = (await container(target))
        .listBlobsFlat({ abortSignal: deadline() })
        .byPage({ maxPageSize: usagePageSize });
      const result = await pages.next();
      if (result.done) return { objects: 0, bytes: 0, complete: true };
      const page = result.value;
      return {
        objects: page.segment.blobItems.length,
        bytes: page.segment.blobItems.reduce(
          (total, entry) => total + (entry.properties.contentLength ?? 0),
          0,
        ),
        complete: !page.continuationToken,
      };
    },
    async stat(target, key) {
      const result = await optional(
        (await blob(target, key)).getProperties({ abortSignal: deadline() }),
      );
      return (
        result &&
        objectInfo(key, result.contentLength, result.etag, result.lastModified)
      );
    },
    async upload(target, key, _size, etag) {
      return {
        url: await signedBlob(target, key, etag ? 'w' : 'c'),
        headers: { 'x-ms-blob-type': 'BlockBlob', ...headersFor(etag) },
      };
    },
    async download(target, key, name) {
      return { url: await signedBlob(target, key, 'r', name) };
    },
    async remove(target, key, etag) {
      await (
        await blob(target, key)
      ).delete({ conditions: { ifMatch: etag }, abortSignal: deadline() });
    },
    async move(target, key, to, etag) {
      // A read SAS authorizes the provider to pull the source. For this internal copy,
      // preserve source properties rather than signing a download content-type override.
      const source = (await blob(target, key)).url;
      const sas = await sign(
        target,
        new Date(Date.now() + signedSeconds * 1000),
        BlobSASPermissions.parse('r'),
        key,
      );
      await (
        await blob(target, to)
      ).syncUploadFromURL(`${source}?${sas}`, {
        conditions: { ifNoneMatch: '*' },
        sourceConditions: { ifMatch: etag },
        copySourceBlobProperties: true,
        abortSignal: deadline(),
      });
      await this.remove(target, key, etag).catch(() => {
        throw new MoveIncomplete();
      });
    },
    async issue(target, minutes, issuanceId) {
      const expiry = new Date(Date.now() + minutes * 60_000);
      return {
        platform: 'azure',
        expiresAt: expiry.toISOString(),
        url: (await container(target)).url,
        sas: await sign(
          target,
          expiry,
          ContainerSASPermissions.parse('cw'),
          undefined,
          undefined,
          issuanceId,
        ),
      };
    },
  };
}
