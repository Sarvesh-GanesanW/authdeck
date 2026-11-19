/**
 * What the QR scanner shows for the camera permission: the camera once granted; before the person
 * was ever asked, a choice between scanning (which asks) and typing the key, never a prompt on open.
 * Pure, so it is testable without the camera module.
 */
export function cameraStep(permission: { granted: boolean; status: string } | null): 'loading' | 'ask' | 'blocked' | 'camera' {
  if (!permission) return 'loading';
  if (permission.granted) return 'camera';
  return permission.status === 'undetermined' ? 'ask' : 'blocked';
}
