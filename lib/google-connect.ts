import { getToken, startAuthorization, UserAuthorizationRequiredError } from '@vercel/connect'

export const GOOGLE_CONNECTOR_UID = 'google/stafftrack-google-calendar'
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/meetings.space.readonly',
]

export function isGoogleAuthorizationRequired(error: unknown) {
  return error instanceof UserAuthorizationRequiredError
}

export function getGoogleUserToken(userId: string) {
  return getToken(GOOGLE_CONNECTOR_UID, {
    subject: { type: 'user', id: userId },
    scopes: GOOGLE_SCOPES,
  })
}

export async function getGoogleAuthorizationUrl(userId: string, callbackUrl: string) {
  const authorization = await startAuthorization(
    GOOGLE_CONNECTOR_UID,
    { subject: { type: 'user', id: userId }, scopes: GOOGLE_SCOPES },
    { callbackUrl },
  )
  return authorization.url
}
