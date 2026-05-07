import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS_URL = new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
);
const JWKS = createRemoteJWKSet(JWKS_URL);

/**
 * Verifies a Firebase Auth JWT on the edge using Google's public JWKS.
 */
export async function verifyFirebaseToken(token: string, projectId: string | undefined) {
  try {
    if (!projectId) {
      console.warn('FIREBASE_PROJECT_ID is not set in env. Verification might be incomplete.');
    }
    
    const verifyOptions = projectId
      ? { issuer: `https://securetoken.google.com/${projectId}`, audience: projectId }
      : undefined;

    const { payload } = await jwtVerify(token, JWKS, verifyOptions);
    return payload as { email?: string; [key: string]: unknown };
  } catch (error) {
    console.warn('JWT Verification failed:', error);
    return null;
  }
}

/**
 * Checks if the given email exists in the allowed_users table.
 * Returns the user row (including role) if they are allowed, otherwise null.
 */
export async function checkIsAllowedUser(email: string | undefined, db: D1Database): Promise<{ email: string, role: string } | null> {
  if (!email) return null;
  
  try {
    const result = await db.prepare('SELECT email, role FROM allowed_users WHERE email = ?')
      .bind(email)
      .first<{ email: string, role: string }>();
    return result || null;
  } catch (error) {
    console.error('Database error checking allowed user:', error);
    return null;
  }
}
