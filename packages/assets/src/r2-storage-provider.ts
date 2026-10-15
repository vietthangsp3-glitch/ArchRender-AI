import { createHash } from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";

import type { AssetStorageConfig } from "./config";
import { mapStorageError, StorageError } from "./errors";
import type {
  BoundedObjectContent,
  CreateImmutableObjectInput,
  CreatePresignedUploadInput,
  PresignedUploadRequest,
  StorageProvider,
  StoredObjectMetadata,
  ReadObjectOptions,
} from "./storage-provider";
import type { StorageObjectKey } from "./types";

type S3Command = PutObjectCommand | GetObjectCommand | HeadObjectCommand | DeleteObjectCommand;
export interface S3ClientPort {
  send(command: S3Command): Promise<unknown>;
}

export type PresignFunction = (
  client: S3ClientPort,
  command: PutObjectCommand | GetObjectCommand,
  expiresInSeconds: number,
) => Promise<string>;

const defaultPresign: PresignFunction = (client, command, expiresInSeconds) => {
  if (command instanceof PutObjectCommand) {
    const metadataHeaders = Object.keys(command.input.Metadata ?? {}).map(
      (key) => `x-amz-meta-${key.toLowerCase()}`,
    );
    const signedUploadHeaders = new Set(["content-length", "content-type", ...metadataHeaders]);
    return getSignedUrl(client as S3Client, command, {
      expiresIn: expiresInSeconds,
      signableHeaders: signedUploadHeaders,
      unhoistableHeaders: new Set(metadataHeaders),
    });
  }
  return getSignedUrl(client as S3Client, command, { expiresIn: expiresInSeconds });
};

function assertTtl(ttl: number): void {
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > 900) {
    throw new StorageError("INVALID_RESPONSE", "presign", false);
  }
}

function toMetadata(output: {
  ContentLength?: number;
  ContentType?: string;
  ETag?: string;
  Metadata?: Record<string, string>;
}): StoredObjectMetadata {
  if (!Number.isSafeInteger(output.ContentLength) || (output.ContentLength ?? -1) < 0) {
    throw new StorageError("INVALID_RESPONSE", "headObject", false);
  }
  return {
    contentLength: output.ContentLength as number,
    contentType: output.ContentType ?? null,
    etag: output.ETag ?? null,
    metadata: output.Metadata ?? {},
  };
}

async function collectBoundedBody(body: unknown, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new StorageError("INVALID_RESPONSE", "readObject", false);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const append = (chunk: Uint8Array) => {
    total += chunk.byteLength;
    if (total > maxBytes) throw new StorageError("INVALID_RESPONSE", "readObject", false);
    chunks.push(chunk);
  };

  if (body && typeof body === "object" && "transformToByteArray" in body) {
    const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    append(bytes);
  } else if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      append(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk));
    }
  } else {
    throw new StorageError("INVALID_RESPONSE", "readObject", false);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export class R2StorageProvider implements StorageProvider {
  constructor(
    private readonly client: S3ClientPort,
    private readonly bucket: string,
    private readonly presign: PresignFunction = defaultPresign,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createPresignedUpload(input: CreatePresignedUploadInput): Promise<PresignedUploadRequest> {
    assertTtl(input.expiresInSeconds);
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
        Metadata: { ...input.metadata },
      });
      const url = await this.presign(this.client, command, input.expiresInSeconds);
      return {
        method: "PUT",
        url,
        expiresAt: new Date(this.now().getTime() + input.expiresInSeconds * 1_000),
        requiredHeaders: {
          "content-type": input.contentType,
          "content-length": String(input.contentLength),
          ...Object.fromEntries(
            Object.entries(input.metadata).map(([key, value]) => [`x-amz-meta-${key.toLowerCase()}`, value]),
          ),
        },
      };
    } catch (error) {
      throw mapStorageError(error, "createPresignedUpload");
    }
  }

  async createPresignedReadUrl(key: StorageObjectKey, expiresInSeconds: number): Promise<string> {
    assertTtl(expiresInSeconds);
    try {
      return await this.presign(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        expiresInSeconds,
      );
    } catch (error) {
      throw mapStorageError(error, "createPresignedReadUrl");
    }
  }

  async headObject(key: StorageObjectKey): Promise<StoredObjectMetadata> {
    try {
      const output = (await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as Parameters<typeof toMetadata>[0];
      return toMetadata(output);
    } catch (error) {
      throw mapStorageError(error, "headObject");
    }
  }

  async readObject(
    key: StorageObjectKey,
    maxBytes: number,
    options: ReadObjectOptions = {},
  ): Promise<BoundedObjectContent> {
    try {
      const output = (await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: `bytes=0-${maxBytes}`,
          ...(options.ifMatch ? { IfMatch: options.ifMatch } : {}),
        }),
      )) as Parameters<typeof toMetadata>[0] & { Body?: unknown };
      const bytes = await collectBoundedBody(output.Body, maxBytes);
      return { ...toMetadata({ ...output, ContentLength: bytes.byteLength }), bytes };
    } catch (error) {
      throw mapStorageError(error, "readObject");
    }
  }

  async createImmutableObject(input: CreateImmutableObjectInput): Promise<StoredObjectMetadata> {
    if (input.bytes.byteLength <= 0) {
      throw new StorageError("INVALID_RESPONSE", "createImmutableObject", false);
    }
    try {
      const output = (await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.bytes,
        ContentLength: input.bytes.byteLength,
        ContentType: input.contentType,
        ContentMD5: createHash("md5").update(input.bytes).digest("base64"),
        IfNoneMatch: "*",
        Metadata: { ...input.metadata },
      }))) as { ETag?: string };
      return {
        contentLength: input.bytes.byteLength,
        contentType: input.contentType,
        etag: output.ETag ?? null,
        metadata: input.metadata,
      };
    } catch (error) {
      throw mapStorageError(error, "createImmutableObject");
    }
  }

  async deleteObject(key: StorageObjectKey): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw mapStorageError(error, "deleteObject");
    }
  }

  async objectExists(key: StorageObjectKey): Promise<boolean> {
    try {
      await this.headObject(key);
      return true;
    } catch (error) {
      if (error instanceof StorageError && error.code === "NOT_FOUND") return false;
      throw error;
    }
  }
}

export function createR2StorageProvider(config: AssetStorageConfig): R2StorageProvider {
  const client = new S3Client({
    ...createR2S3ClientConfig(config),
    requestHandler: new NodeHttpHandler({ connectionTimeout: 3_000, requestTimeout: 15_000 }),
  });
  return new R2StorageProvider(client, config.bucket);
}

export function createR2S3ClientConfig(config: AssetStorageConfig): S3ClientConfig {
  return {
    region: "auto",
    endpoint: config.endpoint,
    credentials: config.credentials,
    maxAttempts: config.environment === "development" ? 1 : 3,
    // R2 supports Content-MD5 for PutObject but not the AWS SDK's optional
    // CRC32 full-object checksum headers. Keep the explicit Content-MD5 and
    // disable only optional SDK checksum calculation.
    requestChecksumCalculation: "WHEN_REQUIRED",
  };
}
