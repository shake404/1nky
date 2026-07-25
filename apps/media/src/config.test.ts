import { describe, expect, it } from 'vitest';

import { loadConfig, loadS3Config, type Env } from './config.js';

const S3_ENV: Env = {
  R2_ACCOUNT_ID: 'abc123',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: '1nky-media',
};

describe('loadConfig', () => {
  it('falls back to the documented defaults', () => {
    const cfg = loadConfig({});
    expect(cfg.port).toBe(3002);
    expect(cfg.maxUploadBytes).toBe(5 * 1024 * 1024);
    expect(cfg.bucket).toBe('1nky-media');
    expect(cfg.maxDimension).toBe(4096);
  });

  it('reads MEDIA_PORT and MAX_UPLOAD_MB', () => {
    const cfg = loadConfig({ MEDIA_PORT: '9000', MAX_UPLOAD_MB: '12' });
    expect(cfg.port).toBe(9000);
    expect(cfg.maxUploadBytes).toBe(12 * 1024 * 1024);
  });

  it('defaults MAX_VIDEO_MB to 50 and reads an override', () => {
    expect(loadConfig({}).maxVideoBytes).toBe(50 * 1024 * 1024);
    expect(loadConfig({ MAX_VIDEO_MB: '3' }).maxVideoBytes).toBe(3 * 1024 * 1024);
  });

  it('trims the trailing slash off MEDIA_PUBLIC_BASE', () => {
    expect(loadConfig({ MEDIA_PUBLIC_BASE: 'https://cdn.1nky.com/' }).publicBase).toBe(
      'https://cdn.1nky.com',
    );
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig({ MEDIA_PORT: 'http' })).toThrow(/MEDIA_PORT/);
  });
});

describe('loadS3Config', () => {
  it('derives the R2 endpoint from the account id', () => {
    const cfg = loadS3Config(S3_ENV);
    expect(cfg.endpoint).toBe('https://abc123.r2.cloudflarestorage.com');
    expect(cfg.region).toBe('auto');
    expect(cfg.forcePathStyle).toBe(true);
  });

  it('prefers an explicit R2_ENDPOINT', () => {
    const cfg = loadS3Config({ ...S3_ENV, R2_ENDPOINT: 'https://sfo3.object-storage/' });
    expect(cfg.endpoint).toBe('https://sfo3.object-storage');
  });

  it('requires credentials', () => {
    expect(() => loadS3Config({ ...S3_ENV, R2_SECRET_ACCESS_KEY: '' })).toThrow(/R2_ACCESS_KEY_ID/);
  });

  it('requires an endpoint or an account id', () => {
    expect(() =>
      loadS3Config({ R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' }),
    ).toThrow(/R2_ENDPOINT/);
  });
});
