import type { StorageObjectKey } from "./types";

export interface CreatePresignedUploadInput {
  key: StorageObjectKey;
  contentType: string;
  contentLength: number;
  expiresInSeconds: number;
  metadata: Readonly<Record<string, string>>;
}

export interface PresignedUploadRequest {
  method: "PUT";
  url: string;
  expiresAt: Date;
  requiredHeaders: Readonly<Record<string, string>>;
}

export interface StoredObjectMetadata {
  contentLength: number;
  contentType: string | null;
  etag: string | null;
  metadata: Readonly<Record<string, string>>;
}

export interface BoundedObjectContent extends StoredObjectMetadata {
  bytes: Uint8Array;
}

export interface ReadObjectOptions {
  ifMatch?: string;
}

export interface CreateImmutableObjectInput {
  key: StorageObjectKey;
  bytes: Uint8Array;
  contentType: string;
  metadata: Readonly<Record<string, string>>;
}

export interface StorageProvider {
  createPresignedUpload(input: CreatePresignedUploadInput): Promise<PresignedUploadRequest>;
  createPresignedReadUrl(key: StorageObjectKey, expiresInSeconds: number): Promise<string>;
  headObject(key: StorageObjectKey): Promise<StoredObjectMetadata>;
  readObject(
    key: StorageObjectKey,
    maxBytes: number,
    options?: ReadObjectOptions,
  ): Promise<BoundedObjectContent>;
  createImmutableObject(input: CreateImmutableObjectInput): Promise<StoredObjectMetadata>;
  deleteObject(key: StorageObjectKey): Promise<void>;
  objectExists(key: StorageObjectKey): Promise<boolean>;
}
