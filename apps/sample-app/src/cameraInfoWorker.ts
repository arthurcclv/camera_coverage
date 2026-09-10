/**
 * Center-ray worker for the camera info export (spec §15.3).
 *
 * The app's second worker, and unlike `worker.ts` it hosts nothing: it exists
 * only so ~96 brute-force ray casts against a multi-million-triangle collision
 * mesh do not freeze the viewport for ten seconds. One message in, one message
 * out, no state between them — App creates it per export and terminates it on
 * the reply.
 *
 * Every decision lives in the pure `cameras/centerRay.ts`, tested there; this
 * file is the transport and nothing else.
 */
import { centerRayHits, type RayPose } from './cameras/centerRay.ts';

/** What App posts: the world-space collision mesh plus one pose per camera. */
export interface CenterRayRequest {
  positions: Float32Array;
  indices: Uint32Array;
  poses: RayPose[];
}

/** What comes back: one hit point per pose, in order, `null` for a miss. */
export interface CenterRayResponse {
  hits: (import('@linkervision/camera-coverage-sdk').Vec3 | null)[];
}

self.onmessage = (ev: MessageEvent<CenterRayRequest>) => {
  const { positions, indices, poses } = ev.data;
  const hits = centerRayHits({ positions, indices }, poses);
  (self as unknown as Worker).postMessage({ hits } satisfies CenterRayResponse);
};
