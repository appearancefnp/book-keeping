/** 'misconfigured' ⇔ deployed to Vercel without a blob token (first upload would 500 with EROFS). */
export function blobConfigStatus(env: { VERCEL_ENV?: string; BLOB_READ_WRITE_TOKEN?: string }): 'ok' | 'misconfigured' {
  return env.VERCEL_ENV && !env.BLOB_READ_WRITE_TOKEN ? 'misconfigured' : 'ok';
}
